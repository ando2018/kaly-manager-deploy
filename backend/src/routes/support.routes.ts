import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { contactMessages } from '../data/contact-messages';
import { platform } from '../data/platform';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const supportRouter = Router();

supportRouter.use(requireAuth);

/**
 * Lets any signed-in team member reach the Kaly Manager platform administrator from inside the app.
 * The établissement is taken from the verified session, not from client input.
 */
supportRouter.post('/', (req, res) => {
  const { email, phone, message } = req.body as { email?: string; phone?: string; message?: string };
  if (!email?.trim() || !phone?.trim() || !message?.trim()) {
    res.status(400).json({ error: 'email, phone et message sont requis.' });
    return;
  }
  if (!EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'Adresse e-mail invalide.' });
    return;
  }

  const meta = platform.findEtablissement(req.etablissementId!);
  const created = contactMessages.create({
    name: req.user!.name,
    email,
    phone,
    message,
    etablissementIdAttempt: req.etablissementId,
    etablissementName: meta?.name,
  });
  res.status(201).json(created);
});
