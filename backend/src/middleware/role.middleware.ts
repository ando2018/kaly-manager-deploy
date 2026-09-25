import { NextFunction, Request, Response } from 'express';
import { UserRole } from '../models/types';

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role) {
      res.status(401).json({ error: 'Authentification requise.' });
      return;
    }
    // EVENT_MANAGER has full ADMIN-equivalent functionality everywhere — the one restriction (can't
    // touch an évènement they aren't assigned to) is enforced separately, by enforceEventManagerScope
    // (X-Event-Id-scoped routes) and requireOwnEventForManager (évènement :id routes), not here.
    if (role === 'ADMIN' || role === 'EVENT_MANAGER' || roles.includes(role)) {
      next();
      return;
    }
    res.status(403).json({ error: "Accès refusé pour votre rôle." });
  };
}
