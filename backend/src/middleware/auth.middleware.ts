import { NextFunction, Request, Response } from 'express';
import { TokenPayload, verifyToken } from '../services/auth.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/** Requires resolveEtablissement to have run first — it cross-checks the token's établissement against the URL's. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session invalide ou expirée.' });
    return;
  }
  if (req.etablissementId && payload.etablissementId !== req.etablissementId) {
    res.status(401).json({ error: 'Cette session appartient à un autre établissement.' });
    return;
  }
  if (req.etablissement) {
    const currentUser = req.etablissement.auth.getPublicUser(payload.sub);
    if (!currentUser || currentUser.suspended) {
      res.status(403).json({ error: 'Ce compte est suspendu.' });
      return;
    }
  }
  req.user = payload;
  next();
}
