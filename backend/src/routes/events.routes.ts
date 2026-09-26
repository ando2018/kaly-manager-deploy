import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireOwnEventForManager } from '../middleware/event.middleware';
import { requireAdminOnly, requireRole } from '../middleware/role.middleware';
import { EventError } from '../services/events.service';
import { broadcastEvents } from '../sockets/io';

export const eventsRouter = Router();

eventsRouter.use(requireAuth);

function handle(req: Request, res: Response, fn: () => unknown, status = 200): void {
  try {
    const result = fn();
    res.status(status).json(result);
  } catch (err) {
    if (err instanceof EventError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}

// Open to any authenticated role — every staff member needs this list to choose their évènement after
// login. EVENT_MANAGER is the one exception with narrower vision: filtered down to their own évènement(s)
// — the single restriction their otherwise ADMIN-equivalent access carries (see requireRole).
eventsRouter.get('/', (req, res) => {
  const events = req.etablissement!.events.list();
  if (req.user?.role === 'EVENT_MANAGER') {
    res.json(events.filter((e) => e.assignedUserIds.includes(req.user!.sub)));
    return;
  }
  res.json(events);
});

function parseServiceType(value: unknown): 'STANDARD' | 'COUNTER' | undefined {
  return value === 'STANDARD' || value === 'COUNTER' ? value : undefined;
}

function parseTableCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Creating and deleting évènements is reserved to the Direction — an EVENT_MANAGER only runs their own.
eventsRouter.post('/', requireAdminOnly, (req, res) => {
  const { name, description, serviceType, tableCount } = req.body ?? {};
  handle(
    req,
    res,
    () => {
      const event = req.etablissement!.events.create(
        { name, description, serviceType: parseServiceType(serviceType), tableCount: parseTableCount(tableCount) },
        req.user!.sub,
      );
      // An EVENT_MANAGER only ever sees/acts on évènements they're assigned to — auto-assign the
      // creator, otherwise they'd create it and immediately lose access to what they just made.
      if (req.user!.role === 'EVENT_MANAGER') {
        req.etablissement!.events.addMember(event.id, req.user!.sub);
      }
      broadcastEvents(req.etablissementId!);
      return req.etablissement!.events.get(event.id);
    },
    201,
  );
});

eventsRouter.patch('/:id', requireRole('ADMIN'), requireOwnEventForManager, (req, res) => {
  const { name, description, serviceType, tableCount } = req.body ?? {};
  handle(req, res, () => {
    const event = req.etablissement!.events.update(req.params.id, {
      name,
      description,
      serviceType: parseServiceType(serviceType),
      tableCount: parseTableCount(tableCount),
    });
    broadcastEvents(req.etablissementId!);
    return event;
  });
});

eventsRouter.patch('/:id/status', requireRole('ADMIN'), requireOwnEventForManager, (req, res) => {
  const { status } = req.body as { status?: string };
  if (status !== 'ACTIVE' && status !== 'CLOSED') {
    res.status(400).json({ error: 'status doit être ACTIVE ou CLOSED.' });
    return;
  }
  handle(req, res, () => {
    const event = req.etablissement!.events.setStatus(req.params.id, status);
    broadcastEvents(req.etablissementId!);
    return event;
  });
});

eventsRouter.post('/:id/members', requireRole('ADMIN'), requireOwnEventForManager, (req, res) => {
  const { userId } = req.body as { userId?: string };
  if (!userId) {
    res.status(400).json({ error: 'userId est requis.' });
    return;
  }
  handle(req, res, () => {
    const event = req.etablissement!.events.addMember(req.params.id, userId);
    broadcastEvents(req.etablissementId!);
    return event;
  });
});

eventsRouter.delete('/:id/members/:userId', requireRole('ADMIN'), requireOwnEventForManager, (req, res) => {
  if (req.params.userId === req.user!.sub) {
    res.status(403).json({ error: 'Vous ne pouvez pas retirer votre propre affectation à un évènement.' });
    return;
  }
  const target = req.etablissement!.users.list().find((u) => u.id === req.params.userId);
  if (target?.role === 'ADMIN' && req.user!.role !== 'ADMIN') {
    res.status(403).json({ error: "Seule la direction peut retirer un compte Direction d'un évènement." });
    return;
  }
  handle(req, res, () => {
    const event = req.etablissement!.events.removeMember(req.params.id, req.params.userId);
    broadcastEvents(req.etablissementId!);
    return event;
  });
});

eventsRouter.delete('/:id', requireAdminOnly, (req, res) => {
  handle(req, res, () => {
    req.etablissement!.events.remove(req.params.id);
    broadcastEvents(req.etablissementId!);
    return { ok: true };
  });
});
