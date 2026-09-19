import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
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

// Open to any authenticated role — every staff member needs this list to choose their évènement after login.
eventsRouter.get('/', (req, res) => {
  res.json(req.etablissement!.events.list());
});

eventsRouter.post('/', requireRole('ADMIN'), (req, res) => {
  const { name, description } = req.body ?? {};
  handle(
    req,
    res,
    () => {
      const event = req.etablissement!.events.create({ name, description }, req.user!.sub);
      broadcastEvents(req.etablissementId!);
      return event;
    },
    201,
  );
});

eventsRouter.patch('/:id', requireRole('ADMIN'), (req, res) => {
  const { name, description } = req.body ?? {};
  handle(req, res, () => {
    const event = req.etablissement!.events.update(req.params.id, { name, description });
    broadcastEvents(req.etablissementId!);
    return event;
  });
});

eventsRouter.patch('/:id/status', requireRole('ADMIN'), (req, res) => {
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

eventsRouter.post('/:id/members', requireRole('ADMIN'), (req, res) => {
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

eventsRouter.delete('/:id/members/:userId', requireRole('ADMIN'), (req, res) => {
  handle(req, res, () => {
    const event = req.etablissement!.events.removeMember(req.params.id, req.params.userId);
    broadcastEvents(req.etablissementId!);
    return event;
  });
});

eventsRouter.delete('/:id', requireRole('ADMIN'), (req, res) => {
  handle(req, res, () => {
    req.etablissement!.events.remove(req.params.id);
    broadcastEvents(req.etablissementId!);
    return { ok: true };
  });
});
