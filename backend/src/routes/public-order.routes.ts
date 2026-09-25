import { Request, Response, Router } from 'express';
import { OrderError } from '../services/orders.service';
import { broadcastMenu, broadcastOrders } from '../sockets/io';

/**
 * Reachable by a customer's phone after scanning a table's QR code — no login. Only mounted behind
 * `resolveEtablissement` (établissement id + archived + subscription checks still apply), never
 * `requireAuth`. Deliberately narrow: browse the available menu and place/add to one TABLE order for
 * a given table number, nothing else a staff account can do.
 */
export const publicOrderRouter = Router();

function handle(req: Request, res: Response, fn: () => unknown, status = 200): void {
  try {
    const result = fn();
    res.status(status).json(result);
  } catch (err) {
    if (err instanceof OrderError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}

/** Only what a customer needs to build an order — never the full staff catalogue (out-of-stock items excluded).
 * Lenient about a stale/invalid `event` query param, same as GET /table/:tableNumber — falls back to normal service. */
publicOrderRouter.get('/menu', (req, res) => {
  const ctx = req.etablissement!;
  const rawEventId = typeof req.query.event === 'string' && req.query.event ? req.query.event : undefined;
  const event = rawEventId ? ctx.events.get(rawEventId) : undefined;
  const resolvedEventId = event && event.status === 'ACTIVE' ? event.id : undefined;
  res.json(ctx.menu.list(resolvedEventId).filter((m) => m.isAvailable));
});

/**
 * The still-open order for this table (if any), so the page can show "already sent" items before a
 * customer builds a new round. Lenient about a stale/invalid `event` query param — a passive read,
 * not worth hard-failing the whole page over (the POST /orders validation is what actually matters).
 */
publicOrderRouter.get('/table/:tableNumber', (req, res) => {
  const table = Number(req.params.tableNumber);
  if (!Number.isFinite(table) || table <= 0) {
    res.status(400).json({ error: 'Numéro de table invalide.' });
    return;
  }
  const ctx = req.etablissement!;
  const rawEventId = typeof req.query.event === 'string' && req.query.event ? req.query.event : undefined;
  if (rawEventId) {
    const event = ctx.events.get(rawEventId);
    if (!event || event.status !== 'ACTIVE') {
      // Stale/invalid évènement in the URL — nothing to show under it, but not worth erroring the page over.
      res.json(null);
      return;
    }
    res.json(ctx.orders.findActiveTableOrder(table, event.id) ?? null);
    return;
  }
  res.json(ctx.orders.findActiveTableOrder(table) ?? null);
});

publicOrderRouter.post('/orders', (req, res) => {
  const { tableNumber, guestCount, items, orderNote, eventId } = req.body ?? {};
  const table = Number(tableNumber);
  if (!Number.isFinite(table) || table <= 0) {
    res.status(400).json({ error: 'tableNumber (nombre positif) est requis.' });
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items (non vide) est requis.' });
    return;
  }

  const ctx = req.etablissement!;
  // The QR code for this table encodes which évènement it belongs to — an unknown or no-longer-active
  // id means the code is stale (the évènement was deleted/closed since the code was printed).
  let resolvedEventId: string | undefined;
  if (eventId !== undefined && eventId !== null && eventId !== '') {
    const event = ctx.events.get(String(eventId));
    if (!event || event.status !== 'ACTIVE') {
      res.status(400).json({ error: "Cet évènement n'est plus disponible. Adressez-vous au personnel." });
      return;
    }
    resolvedEventId = event.id;
  }

  handle(req, res, () => {
    // Second round at a table already running its bill joins that same order (one kitchen ticket,
    // one bill) — a fresh order only opens once the previous one has been cashed out or cancelled.
    const existing = ctx.orders.findActiveTableOrder(table, resolvedEventId);
    const order = existing
      ? ctx.orders.addItems(existing.id, items)
      : ctx.orders.submit({
          type: 'TABLE',
          tableNumber: table,
          guestCount: guestCount === undefined ? undefined : Number(guestCount),
          items,
          orderNote,
          waiterName: `Client (Table ${table})`,
          eventId: resolvedEventId,
        });
    broadcastOrders(req.etablissementId!);
    broadcastMenu(req.etablissementId!);
    return order;
  });
});
