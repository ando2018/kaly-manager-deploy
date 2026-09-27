import { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      eventId?: string;
      /** The évènement in X-Event-Id is clôturé: readable (suivi, stats), but nothing new can be recorded. */
      eventClosed?: boolean;
    }
  }
}

const HEADER = 'x-event-id';

/** Requires resolveEtablissement to have run first. An unknown event id is ignored (normal service).
 * A clôturé évènement stays the context — so reads show *its* data, never normal service's — and is
 * flagged, so every write route can refuse it with `rejectIfEventClosed`. */
export function resolveEventContext(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header(HEADER);
  if (raw && req.etablissement) {
    const event = req.etablissement.events.get(raw);
    if (event) {
      req.eventId = event.id;
      req.eventClosed = event.status === 'CLOSED';
      // A clôturé évènement is only consulted by the Direction and its responsable.
      const role = req.user?.role;
      if (req.eventClosed && role && role !== 'ADMIN' && role !== 'EVENT_MANAGER') {
        res.status(403).json({ error: "Cet évènement est clôturé : seuls la direction et le responsable d'évènement y ont accès." });
        return;
      }
    }
  }
  next();
}

export const EVENT_CLOSED_MESSAGE = 'Cet évènement est clôturé : consultation uniquement (suivi et statistiques).';

/** For routes that record something (orders, stock) — nothing new goes into a clôturé évènement. */
export function rejectIfEventClosed(req: Request, res: Response, next: NextFunction): void {
  if (req.eventClosed) {
    res.status(403).json({ error: EVENT_CLOSED_MESSAGE });
    return;
  }
  next();
}

/** EVENT_MANAGER has full ADMIN-equivalent functionality everywhere (see requireRole) — this is the
 * one boundary that survives that: whether they're actually assigned to a given évènement. */
function eventManagerCanAccess(req: Request, eventId: string | undefined): boolean {
  if (!eventId || !req.etablissement) return false;
  const event = req.etablissement.events.get(eventId);
  return !!event && event.assignedUserIds.includes(req.user!.sub);
}

/** Mounted after resolveEventContext on menu/orders routers. Normal service (no X-Event-Id) is always
 * let through — it isn't an évènement, so it's outside the one restriction this role has. An X-Event-Id
 * that resolves to an évènement they aren't assigned to is rejected; everything else passes untouched. */
export function enforceEventManagerScope(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'EVENT_MANAGER' && req.eventId && !eventManagerCanAccess(req, req.eventId)) {
    res.status(403).json({ error: "Vous n'êtes pas affecté à cet évènement." });
    return;
  }
  next();
}

/** For évènement routes addressed by :id (edit/close/delete/members) — a no-op for every other role,
 * since requireRole already grants EVENT_MANAGER the same ADMIN-equivalent access as everyone else here. */
export function requireOwnEventForManager(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'EVENT_MANAGER') {
    next();
    return;
  }
  if (eventManagerCanAccess(req, req.params.id)) {
    next();
    return;
  }
  res.status(403).json({ error: "Vous n'êtes pas affecté à cet évènement." });
}
