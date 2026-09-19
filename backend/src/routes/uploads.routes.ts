import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { imageUpload, UPLOADS_PUBLIC_PATH } from '../middleware/upload.middleware';

export const uploadsRouter = Router();

uploadsRouter.use(requireAuth);

uploadsRouter.post('/image', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  imageUpload.single('image')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Échec de l'upload.";
      res.status(400).json({ error: message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Aucun fichier reçu.' });
      return;
    }
    // Relative on purpose — an absolute URL would freeze whatever host/port served this request into
    // the database forever. The browser resolves this against the page's own origin at render time,
    // so it keeps working regardless of which host/IP/port is used to reach the server later.
    const url = `${UPLOADS_PUBLIC_PATH}/${req.etablissementId}/${req.file.filename}`;
    res.status(201).json({ url });
  });
});
