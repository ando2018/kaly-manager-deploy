import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserError } from '../services/users.service';
import { broadcastUsers } from '../sockets/io';

export const usersRouter = Router();

// EVENT_MANAGER shares ADMIN's account-management access (requireRole treats them the same), except
// on Direction accounts: those stay untouchable from an event manager's space.
usersRouter.use(requireAuth, requireRole('ADMIN'));

usersRouter.param('id', (req, res, next, id: string) => {
  if (req.user?.role !== 'EVENT_MANAGER') return next();
  const target = req.etablissement!.users.list().find((u) => u.id === id);
  if (target?.role === 'ADMIN') {
    res.status(403).json({ error: "Un responsable d'évènement ne peut pas modifier un compte Direction." });
    return;
  }
  next();
});

usersRouter.get('/', (req, res) => {
  res.json(req.etablissement!.users.list());
});

usersRouter.post('/', (req, res) => {
  try {
    const { name, role, pinCode, mustChangePin } = req.body as { name?: string; role?: string; pinCode?: string; mustChangePin?: boolean };
    if (!name || !role || !pinCode || mustChangePin === undefined) {
      res.status(400).json({ error: 'name, role, pinCode et mustChangePin sont requis.' });
      return;
    }
    if (role === 'ADMIN' && req.user!.role === 'EVENT_MANAGER') {
      res.status(403).json({ error: "Un responsable d'évènement ne peut pas créer un compte Direction." });
      return;
    }
    const user = req.etablissement!.users.create({ name, role: role as any, pinCode, mustChangePin });
    broadcastUsers(req.etablissementId!);
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

usersRouter.put('/:id', (req, res) => {
  try {
    const { name, role } = req.body as { name?: string; role?: string };
    if (role === 'ADMIN' && req.user!.role === 'EVENT_MANAGER') {
      res.status(403).json({ error: "Un responsable d'évènement ne peut pas attribuer le rôle Direction." });
      return;
    }
    const user = req.etablissement!.users.update(req.params.id, { name, role: role as any });
    broadcastUsers(req.etablissementId!);
    res.json(user);
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

usersRouter.patch('/:id/pin', (req, res) => {
  try {
    const { pinCode } = req.body as { pinCode?: string };
    if (!pinCode) {
      res.status(400).json({ error: 'pinCode est requis.' });
      return;
    }
    const user = req.etablissement!.users.resetPin(req.params.id, pinCode);
    res.json(user);
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

usersRouter.patch('/:id/suspend', (req, res) => {
  try {
    const { suspended } = req.body as { suspended?: boolean };
    const user = req.etablissement!.users.setSuspended(req.params.id, req.user!.sub, Boolean(suspended));
    broadcastUsers(req.etablissementId!);
    res.json(user);
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

usersRouter.delete('/:id', (req, res) => {
  try {
    req.etablissement!.users.remove(req.params.id, req.user!.sub);
    broadcastUsers(req.etablissementId!);
    res.status(204).send();
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
