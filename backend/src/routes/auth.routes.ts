import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { UserError } from '../services/users.service';

export const authRouter = Router();

authRouter.get('/profiles', (req, res) => {
  res.json(req.etablissement!.auth.listPublicProfiles());
});

authRouter.post('/login', (req, res) => {
  const { userId, pinCode } = req.body as { userId?: string; pinCode?: string };
  if (!userId || !pinCode) {
    res.status(400).json({ error: 'userId et pinCode sont requis.' });
    return;
  }
  const result = req.etablissement!.auth.login(userId, pinCode);
  if ('error' in result) {
    if (result.error === 'suspended') {
      res.status(403).json({ error: 'Ce compte est suspendu. Contactez votre administrateur.' });
      return;
    }
    res.status(401).json({ error: 'Code PIN incorrect.' });
    return;
  }
  res.json(result);
});

authRouter.post('/change-pin', requireAuth, (req, res) => {
  try {
    const { pinCode } = req.body as { pinCode?: string };
    if (!pinCode) {
      res.status(400).json({ error: 'pinCode est requis.' });
      return;
    }
    const user = req.etablissement!.users.changeOwnPin(req.user!.sub, pinCode);
    res.json(user);
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = req.etablissement!.auth.getPublicUser(req.user!.sub);
  if (!user) {
    res.status(404).json({ error: 'Utilisateur introuvable.' });
    return;
  }
  res.json(user);
});
