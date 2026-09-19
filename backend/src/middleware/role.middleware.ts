import { NextFunction, Request, Response } from 'express';
import { UserRole } from '../models/types';

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role) {
      res.status(401).json({ error: 'Authentification requise.' });
      return;
    }
    if (role === 'ADMIN' || roles.includes(role)) {
      next();
      return;
    }
    res.status(403).json({ error: "Accès refusé pour votre rôle." });
  };
}
