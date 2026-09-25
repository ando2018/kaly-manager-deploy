import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { enforceEventManagerScope, resolveEventContext } from '../middleware/event.middleware';
import { requireRole } from '../middleware/role.middleware';
import { OrderError } from '../services/orders.service';
import { broadcastAlerts, broadcastMenu, broadcastOrders } from '../sockets/io';

export const ordersRouter = Router();

ordersRouter.use(requireAuth);
ordersRouter.use(resolveEventContext);
ordersRouter.use(enforceEventManagerScope);

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

ordersRouter.get('/', (req, res) => {
  res.json(req.etablissement!.orders.list());
});

ordersRouter.get('/:id', (req, res) => {
  const order = req.etablissement!.orders.get(req.params.id);
  if (!order) {
    res.status(404).json({ error: 'Commande introuvable.' });
    return;
  }
  res.json(order);
});

ordersRouter.post('/', requireRole('WAITER'), (req, res) => {
  const { type, tableNumber, guestCount, customerName, items, orderNote, draft, eventId } = req.body ?? {};
  if (!type || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'type et items (non vide) sont requis.' });
    return;
  }
  handle(
    req,
    res,
    () => {
      const order = req.etablissement!.orders.submit({
        type,
        tableNumber: tableNumber === undefined ? undefined : Number(tableNumber),
        guestCount: guestCount === undefined ? undefined : Number(guestCount),
        customerName,
        waiterId: req.user!.sub,
        waiterName: req.user!.name,
        items,
        orderNote,
        draft: Boolean(draft),
        eventId: eventId || undefined,
      });
      broadcastOrders(req.etablissementId!);
      broadcastMenu(req.etablissementId!);
      return order;
    },
    201,
  );
});

ordersRouter.post('/:id/items', requireRole('WAITER'), (req, res) => {
  const { items } = req.body as { items?: unknown };
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items (non vide) est requis.' });
    return;
  }
  handle(
    req,
    res,
    () => {
      const order = req.etablissement!.orders.addItems(req.params.id, items as any);
      broadcastOrders(req.etablissementId!);
      broadcastMenu(req.etablissementId!);
      return order;
    },
    201,
  );
});

ordersRouter.delete('/:id/items/:itemId', requireRole('WAITER'), (req, res) => {
  handle(req, res, () => {
    const order = req.etablissement!.orders.removeItem(req.params.id, req.params.itemId);
    broadcastOrders(req.etablissementId!);
    broadcastMenu(req.etablissementId!);
    return order;
  });
});

ordersRouter.patch('/:id/status', requireRole('WAITER', 'KITCHEN', 'CASHIER'), (req, res) => {
  const { status } = req.body as { status?: string };
  if (!status) {
    res.status(400).json({ error: 'status est requis.' });
    return;
  }
  handle(req, res, () => {
    const order = req.etablissement!.orders.setStatus(req.params.id, status as any);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/advance', requireRole('KITCHEN', 'WAITER'), (req, res) => {
  handle(req, res, () => {
    req.etablissement!.orders.assertCanProcess(req.params.id, { id: req.user!.sub, role: req.user!.role });
    if (req.user!.role === 'KITCHEN') {
      req.etablissement!.orders.claim(req.params.id, req.user!.sub, req.user!.name);
    }
    const order = req.etablissement!.orders.advanceTicket(req.params.id);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.patch('/:id/items/:itemId/status', requireRole('KITCHEN'), (req, res) => {
  const { status } = req.body as { status?: string };
  if (!status) {
    res.status(400).json({ error: 'status est requis.' });
    return;
  }
  handle(req, res, () => {
    req.etablissement!.orders.assertCanProcess(req.params.id, { id: req.user!.sub, role: req.user!.role });
    req.etablissement!.orders.claim(req.params.id, req.user!.sub, req.user!.name);
    const order = req.etablissement!.orders.setItemStatus(req.params.id, req.params.itemId, status as any);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/claim', requireRole('KITCHEN'), (req, res) => {
  handle(req, res, () => {
    const order = req.etablissement!.orders.claim(req.params.id, req.user!.sub, req.user!.name);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/release', requireRole('KITCHEN'), (req, res) => {
  handle(req, res, () => {
    req.etablissement!.orders.assertCanProcess(req.params.id, { id: req.user!.sub, role: req.user!.role });
    const order = req.etablissement!.orders.release(req.params.id);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/fast-track', requireRole('CASHIER'), (req, res) => {
  handle(req, res, () => {
    const order = req.etablissement!.orders.fastTrackToReady(req.params.id);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/confirm-to-kitchen', requireRole('CASHIER'), (req, res) => {
  handle(req, res, () => {
    const order = req.etablissement!.orders.confirmDraftToKitchen(req.params.id);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/pay', requireRole('CASHIER'), (req, res) => {
  const { method, amount, split } = req.body as { method?: string; amount?: number; split?: boolean };
  if (!method || amount === undefined) {
    res.status(400).json({ error: 'method et amount sont requis.' });
    return;
  }
  handle(req, res, () => {
    const order = req.etablissement!.orders.pay(req.params.id, method as any, Number(amount), Boolean(split));
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/pickup', requireRole('CASHIER', 'COMPTOIR'), (req, res) => {
  handle(req, res, () => {
    const order = req.etablissement!.orders.pickup(req.params.id);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/cancel', requireRole('WAITER', 'CASHIER'), (req, res) => {
  const { reason } = req.body as { reason?: string };
  handle(req, res, () => {
    const order = req.etablissement!.orders.cancel(req.params.id, reason, req.user!.name);
    broadcastOrders(req.etablissementId!);
    return order;
  });
});

ordersRouter.post('/:id/messages', requireRole('WAITER', 'KITCHEN'), (req, res) => {
  const { content, isUrgent, senderRole: requestedRole } = req.body as {
    content?: string;
    isUrgent?: boolean;
    senderRole?: 'WAITER' | 'KITCHEN';
  };
  if (!content) {
    res.status(400).json({ error: 'content est requis.' });
    return;
  }
  const senderRole =
    req.user!.role === 'ADMIN' || req.user!.role === 'EVENT_MANAGER'
      ? (requestedRole ?? 'WAITER')
      : req.user!.role === 'KITCHEN'
        ? 'KITCHEN'
        : 'WAITER';
  handle(
    req,
    res,
    () => {
      const result = req.etablissement!.orders.addMessage(req.params.id, senderRole, content, Boolean(isUrgent));
      broadcastOrders(req.etablissementId!);
      if (result.kitchenAlert) broadcastAlerts(req.etablissementId!);
      return result.order;
    },
    201,
  );
});

ordersRouter.post('/:id/alert-waiter', requireRole('KITCHEN'), (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message) {
    res.status(400).json({ error: 'message est requis.' });
    return;
  }
  handle(
    req,
    res,
    () => {
      const alert = req.etablissement!.orders.alertWaiter(req.params.id, message);
      broadcastAlerts(req.etablissementId!);
      return alert;
    },
    201,
  );
});

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

alertsRouter.get('/waiter', (req, res) => res.json(req.etablissement!.orders.listWaiterAlerts()));
alertsRouter.get('/kitchen', (req, res) => res.json(req.etablissement!.orders.listKitchenAlerts()));

alertsRouter.delete('/waiter/:id', (req, res) => {
  req.etablissement!.orders.dismissWaiterAlert(req.params.id);
  broadcastAlerts(req.etablissementId!);
  res.status(204).send();
});

alertsRouter.delete('/kitchen/:id', (req, res) => {
  req.etablissement!.orders.dismissKitchenAlert(req.params.id);
  broadcastAlerts(req.etablissementId!);
  res.status(204).send();
});
