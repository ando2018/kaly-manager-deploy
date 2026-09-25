import { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      eventId?: string;
    }
  }
}

const HEADER = 'x-event-id';

/** Requires resolveEtablissement to have run first. Lenient: an unknown/inactive event id is simply
 * ignored (falls back to normal service) rather than erroring. */
export function resolveEventContext(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header(HEADER);
  if (raw && req.etablissement) {
    const event = req.etablissement.events.get(raw);
    if (event && event.status === 'ACTIVE') {
      req.eventId = event.id;
    }
  }
  next();
}

/** EVENT_MANAGER has full ADMIN-equivalent functionality everywhere (see requireRole) — this is the
 * one boundary that survives that: whether they're actually assigned to a given évènement. */
function eventManagerCanAccess(req: Request, eventId: string | undefined): boolean {
  if (!eventId || !req.etablissement) return false;
  const event = req.etablissement.events.get(eventId);
  return !!event && event.assignedUserIds.includes(req.user!.sub);
}

/** Mounted after resolveEventContext on menu/orders routers. Normal service (no X-Event-Id) is always
 * let through — it isn't an évènement, so it's outside the one restriction this role has. An X-Event-Id
 * that resolves to an évènement they aren't assigned to is rejected; everything else passes untouched. */
export function enforceEventManagerScope(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'EVENT_MANAGER' && req.eventId && !eventManagerCanAccess(req, req.eventId)) {
    res.status(403).json({ error: "Vous n'êtes pas affecté à cet évènement." });
    return;
  }
  next();
}

/** For évènement routes addressed by :id (edit/close/delete/members) — a no-op for every other role,
 * since requireRole already grants EVENT_MANAGER the same ADMIN-equivalent access as everyone else here. */
export function requireOwnEventForManager(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'EVENT_MANAGER') {
    next();
    return;
  }
  if (eventManagerCanAccess(req, req.params.id)) {
    next();
    return;
  }
  res.status(403).json({ error: "Vous n'êtes pas affecté à cet évènement." });
}
