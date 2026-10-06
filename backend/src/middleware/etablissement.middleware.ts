import { NextFunction, Request, Response } from 'express';
import { EtablissementContext, ensureEtablissementContext } from '../data/etablissement-registry';
import { platform } from '../data/platform';
import { asyncHandler } from '../utils/async-handler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      etablissementId?: string;
      etablissement?: EtablissementContext;
    }
  }
}

const HEADER = 'x-etablissement-id';

/** Writes still allowed while consultation-only: signing in, and writing to the platform (Contact) — a
 * lapsed établissement is exactly the one that needs to reach us; it records nothing in its own data. */
const READ_ONLY_ALLOWED_WRITES = ['/api/auth/login', '/api/auth/change-pin', '/api/support'];

export const resolveEtablissement = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const raw = req.header(HEADER);
  if (!raw) {
    res.status(400).json({ error: "En-tête X-Etablissement-Id manquant. Connectez-vous d'abord à un établissement." });
    return;
  }

  let context: EtablissementContext | undefined;
  try {
    context = await ensureEtablissementContext(raw);
  } catch (err) {
    console.error(`Chargement impossible de l'établissement ${raw} :`, err instanceof Error ? err.message : err);
    res.status(503).json({
      error: `Les données de cet établissement sont indisponibles (${err instanceof Error ? err.message.replace(/\.$/, '') : 'erreur de stockage'}). Contactez l'administrateur de la plateforme.`,
    });
    return;
  }
  if (!context) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }

  const meta = platform.findEtablissement(context.id);
  const subscription = platform.subscriptionStatus(context.id);
  if (subscription?.readOnly) {
    // Lapsed subscription: consultation only — reads, signing in, nothing that records anything.
    if (req.method !== 'GET' && !READ_ONLY_ALLOWED_WRITES.some((path) => req.originalUrl.startsWith(path))) {
      res.status(403).json({ error: 'subscription_readonly' });
      return;
    }
  } else {
    if (meta?.archived) {
      res.status(403).json({ error: 'archived' });
      return;
    }
    if (subscription && !subscription.active) {
      res.status(403).json({ error: 'subscription_expired' });
      return;
    }
  }

  platform.touchActivity(context.id);

  req.etablissementId = context.id;
  req.etablissement = context;
  next();
});
