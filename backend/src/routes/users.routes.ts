import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserError } from '../services/users.service';
import { broadcastUsers } from '../sockets/io';

export const usersRouter = Router();

// EVENT_MANAGER has the same full account-management access as ADMIN here (requireRole treats them
// the same) — nothing user-account-specific to restrict further, unlike the évènement-scoped routes.
usersRouter.use(requireAuth, requireRole('ADMIN'));

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
