import fs from 'node:fs';
import path from 'node:path';
import { NextFunction, Request, Response, Router } from 'express';
import { config } from '../config';
import { platform } from '../data/platform';
import { buildDemoSeed } from '../data/db';
import { contactMessages } from '../data/contact-messages';
import { ensureEtablissementContext, evictEtablissementContext } from '../data/etablissement-registry';
import {
  clearFirebaseServiceAccount,
  getFirebaseProjectId,
  isFirebaseConfigured,
  setFirebaseServiceAccount,
} from '../data/firebase-admin';
import { StorageBackend } from '../data/platform';
import { PLAN_DAYS, SubscriptionPlan, subscriptions } from '../data/subscriptions';
import { etablissementUploadsDir } from '../middleware/upload.middleware';
import { broadcastUsers } from '../sockets/io';
import { asyncHandler } from '../utils/async-handler';

const ETABLISSEMENTS_DATA_ROOT = path.resolve(__dirname, '..', '..', 'data', 'etablissements');

export const platformRouter = Router();

function requirePlatformKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('x-platform-key');
  if (!key || key !== config.platformAdminKey) {
    res.status(401).json({ error: "Clé d'administration plateforme invalide." });
    return;
  }
  next();
}

/** Public — the établissement-connection screen checks an id exists before storing it. */
platformRouter.get('/etablissements/:id/exists', (req, res) => {
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  if (meta.archived) {
    res.status(403).json({ error: 'archived' });
    return;
  }
  res.json({ id: meta.id, name: meta.name });
});

/** Public — the établissement-connection screen checks this right after `exists` to decide whether to show the login form or the subscription/token screen. */
platformRouter.get('/etablissements/:id/subscription-status', (req, res) => {
  const status = platform.subscriptionStatus(req.params.id);
  if (!status) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  res.json(status);
});

/** Public — informational pricing shown on the subscription/token screen (no online payment yet). */
platformRouter.get('/subscription-plans', (_req, res) => {
  res.json(subscriptions.getPricing());
});

const PLAN_VALUES: SubscriptionPlan[] = ['WEEK', 'MONTH', 'YEAR'];

/** Public — an établissement's own staff redeem a token here to unlock/extend access, no platform key needed. */
platformRouter.post('/etablissements/:id/subscription/redeem', (req, res) => {
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  const { tokenCode } = req.body as { tokenCode?: string };
  if (!tokenCode?.trim()) {
    res.status(400).json({ error: 'tokenCode est requis.' });
    return;
  }
  try {
    const token = subscriptions.redeemToken(tokenCode, meta.id);
    const status = platform.extendSubscription(meta.id, {
      source: 'TOKEN',
      plan: token.plan,
      days: PLAN_DAYS[token.plan],
      tokenCode: token.code,
    });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Token invalide.' });
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public — the "need help" contact form on the établissement-connection screen, reachable before any key exists. */
platformRouter.post('/contact', (req, res) => {
  const { name, email, phone, message, etablissementIdAttempt } = req.body as {
    name?: string;
    email?: string;
    phone?: string;
    message?: string;
    etablissementIdAttempt?: string;
  };
  if (!name?.trim() || !email?.trim() || !phone?.trim() || !message?.trim()) {
    res.status(400).json({ error: 'name, email, phone et message sont requis.' });
    return;
  }
  if (!EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'Adresse e-mail invalide.' });
    return;
  }
  const created = contactMessages.create({ name, email, phone, message, etablissementIdAttempt });
  res.status(201).json(created);
});

platformRouter.use(requirePlatformKey);

platformRouter.get('/etablissements', (_req, res) => {
  res.json(platform.listEtablissements());
});

platformRouter.post('/etablissements', (req, res) => {
  const { name, adminName } = req.body as { name?: string; adminName?: string };
  if (!name?.trim() || !adminName?.trim()) {
    res.status(400).json({ error: "name et adminName sont requis." });
    return;
  }
  const meta = platform.createEtablissement(name, adminName);
  res.status(201).json(meta);
});

/**
 * Creates a permanent, non-deletable établissement pre-seeded with a demo menu and one user per
 * role (WAITER/KITCHEN/CASHIER/ADMIN/COMPTOIR) — a standing sandbox for testing, never wiped out by
 * one-by-one cleanup elsewhere on the platform.
 */
platformRouter.post('/etablissements/test-base', (_req, res) => {
  const meta = platform.createEtablissement('Établissement de Test (toutes les rôles)', 'Admin Test');
  platform.setProtected(meta.id, true);
  // Standing sandbox — never gated behind a subscription.
  platform.extendSubscription(meta.id, { source: 'ADMIN', days: 365 * 100 });

  const dbPath = path.join(ETABLISSEMENTS_DATA_ROOT, meta.id, 'db.json');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(buildDemoSeed(), null, 2));

  res.status(201).json(platform.findEtablissement(meta.id));
});

/** Permanently deletes exactly this établissement (data + uploads) — refused for protected ones. */
platformRouter.delete(
  '/etablissements/:id',
  asyncHandler(async (req, res) => {
    const meta = platform.findEtablissement(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    if (meta.protected) {
      res.status(403).json({ error: 'Cet établissement est protégé et ne peut pas être supprimé.' });
      return;
    }

    evictEtablissementContext(meta.id);
    await clearFirebaseServiceAccount(meta.id);
    fs.rmSync(path.join(ETABLISSEMENTS_DATA_ROOT, meta.id), { recursive: true, force: true });
    fs.rmSync(etablissementUploadsDir(meta.id), { recursive: true, force: true });
    platform.remove(meta.id);

    res.json({ ok: true });
  }),
);

platformRouter.patch('/etablissements/:id/archive', (req, res) => {
  const { archived } = req.body as { archived?: boolean };
  if (typeof archived !== 'boolean') {
    res.status(400).json({ error: 'archived (boolean) est requis.' });
    return;
  }
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  res.json(platform.setArchived(req.params.id, archived));
});

function generateRandomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Platform-level PIN reset for an établissement's founding admin — used when they lose access entirely. */
platformRouter.post(
  '/etablissements/:id/reset-admin-pin',
  asyncHandler(async (req, res) => {
    const context = await ensureEtablissementContext(req.params.id);
    if (!context) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    const adminUser = context.db.data.users.find((u) => u.role === 'ADMIN');
    if (!adminUser) {
      res.status(404).json({ error: 'Aucun compte administrateur trouvé pour cet établissement.' });
      return;
    }
    const pinCode = generateRandomPin();
    const updated = context.users.resetPin(adminUser.id, pinCode);
    broadcastUsers(context.id);
    res.json({ userId: updated.id, userName: updated.name, pinCode });
  }),
);

/** Lightweight cross-établissement dashboard: status, last activity, usage — no per-order/menu detail. */
platformRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const overview = await Promise.all(
      platform.listEtablissements().map(async (meta) => {
        const context = await ensureEtablissementContext(meta.id);
        return {
          id: meta.id,
          name: meta.name,
          adminName: meta.adminName ?? null,
          archived: meta.archived ?? false,
          protected: meta.protected ?? false,
          createdAt: meta.createdAt,
          lastActivityAt: meta.lastActivityAt ?? null,
          storageBackend: meta.storageBackend ?? 'LOCAL',
          subscription: platform.subscriptionStatus(meta.id) ?? null,
          userCount: context?.db.data.users.length ?? 0,
          orderCount: context?.db.data.orders.length ?? 0,
        };
      }),
    );
    res.json(overview);
  }),
);

/** This établissement's Firebase configuration status — never returns the credential itself. */
platformRouter.get('/etablissements/:id/firebase-config', (req, res) => {
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  res.json({ configured: isFirebaseConfigured(meta.id), projectId: getFirebaseProjectId(meta.id) ?? null });
});

/**
 * Stores (and connection-tests) this établissement's own Firebase service-account key. Two
 * établissements may paste the same key — they'll share the underlying Firebase project but stay
 * isolated in their own Firestore document, same as two LOCAL établissements each get their own
 * db.json.
 */
platformRouter.put(
  '/etablissements/:id/firebase-config',
  asyncHandler(async (req, res) => {
    const meta = platform.findEtablissement(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    const { serviceAccountJson } = req.body as { serviceAccountJson?: string };
    if (!serviceAccountJson?.trim()) {
      res.status(400).json({ error: 'serviceAccountJson est requis.' });
      return;
    }
    try {
      const { projectId } = await setFirebaseServiceAccount(meta.id, serviceAccountJson);
      res.json({ configured: true, projectId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Configuration Firebase invalide.' });
    }
  }),
);

/** Removes this établissement's Firebase configuration — refused while it's still the active backend. */
platformRouter.delete(
  '/etablissements/:id/firebase-config',
  asyncHandler(async (req, res) => {
    const meta = platform.findEtablissement(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    if (meta.storageBackend === 'FIRESTORE') {
      res.status(409).json({ error: "Cet établissement utilise encore Firestore. Repassez-le en local d'abord." });
      return;
    }
    await clearFirebaseServiceAccount(meta.id);
    res.json({ configured: false });
  }),
);

/** Switches one établissement's storage backend. Switching to Firestore requires that établissement's own Firebase config and starts it fresh there (no automatic copy of its local data). */
platformRouter.patch(
  '/etablissements/:id/storage',
  asyncHandler(async (req, res) => {
    const { backend } = req.body as { backend?: StorageBackend };
    if (backend !== 'LOCAL' && backend !== 'FIRESTORE') {
      res.status(400).json({ error: "backend doit être 'LOCAL' ou 'FIRESTORE'." });
      return;
    }
    const meta = platform.findEtablissement(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    if (backend === 'FIRESTORE' && !isFirebaseConfigured(meta.id)) {
      res.status(409).json({ error: "Configurez d'abord Firebase pour cet établissement." });
      return;
    }
    if ((meta.storageBackend ?? 'LOCAL') === backend) {
      res.json(meta);
      return;
    }

    evictEtablissementContext(meta.id);
    const updated = platform.setStorageBackend(meta.id, backend);

    // Warm the new backend immediately so a bad Firestore connection surfaces here, not on the next café order.
    try {
      await ensureEtablissementContext(meta.id);
    } catch (err) {
      evictEtablissementContext(meta.id);
      platform.setStorageBackend(meta.id, meta.storageBackend ?? 'LOCAL');
      res.status(502).json({ error: err instanceof Error ? err.message : 'Échec de connexion au nouveau backend.' });
      return;
    }

    res.json(updated);
  }),
);

/** Updates the platform-wide pricing shown on the subscription screen (informational — no payment processing yet). */
platformRouter.put('/subscription-plans', (req, res) => {
  const { WEEK, MONTH, YEAR } = req.body as { WEEK?: number; MONTH?: number; YEAR?: number };
  if ([WEEK, MONTH, YEAR].some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
    res.status(400).json({ error: 'WEEK, MONTH et YEAR (nombres positifs) sont requis.' });
    return;
  }
  res.json(subscriptions.setPricing({ WEEK: WEEK!, MONTH: MONTH!, YEAR: YEAR! }));
});

platformRouter.get('/subscription-tokens', (_req, res) => {
  res.json(subscriptions.listTokens());
});

/** Generates fresh, unused tokens for one plan — handed to an établissement to redeem on the gate screen. */
platformRouter.post('/subscription-tokens', (req, res) => {
  const { plan, count, paid, note } = req.body as { plan?: SubscriptionPlan; count?: number; paid?: boolean; note?: string };
  if (!plan || !PLAN_VALUES.includes(plan)) {
    res.status(400).json({ error: "plan doit être 'WEEK', 'MONTH' ou 'YEAR'." });
    return;
  }
  const n = Number(count ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    res.status(400).json({ error: 'count doit être un entier entre 1 et 100.' });
    return;
  }
  const created = subscriptions.generateTokens(plan, n, Boolean(paid), note);
  res.status(201).json(created);
});

/** Pulls an unused token back out of circulation — refused once redeemed. */
platformRouter.delete('/subscription-tokens/:code', (req, res) => {
  try {
    subscriptions.revokeToken(req.params.code);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Impossible de révoquer ce token.' });
  }
});

/** Full subscription status + redemption history for one établissement — the platform admin's detail view. */
platformRouter.get('/etablissements/:id/subscription', (req, res) => {
  const detail = platform.subscriptionDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  res.json(detail);
});

/** Direct admin grant — bypasses tokens entirely (VIP accounts, goodwill extensions, the test sandbox). */
platformRouter.post('/etablissements/:id/subscription/grant', (req, res) => {
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  const { plan, days } = req.body as { plan?: SubscriptionPlan; days?: number };
  let grantedDays: number;
  if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
    grantedDays = Math.round(days);
  } else if (plan && PLAN_VALUES.includes(plan)) {
    grantedDays = PLAN_DAYS[plan];
  } else {
    res.status(400).json({ error: "Fournissez plan ('WEEK'/'MONTH'/'YEAR') ou days (nombre de jours)." });
    return;
  }
  const status = platform.extendSubscription(meta.id, { source: 'ADMIN', days: grantedDays, plan });
  res.json(status);
});

/**
 * Admin kill switch — cuts access immediately regardless of remaining trial/paid time. The
 * établissement then sees the same "insert a token" screen as a naturally expired subscription;
 * redeeming a token (or a later admin grant) lifts the suspension automatically.
 */
platformRouter.patch('/etablissements/:id/subscription/suspend', (req, res) => {
  const { suspended } = req.body as { suspended?: boolean };
  if (typeof suspended !== 'boolean') {
    res.status(400).json({ error: 'suspended (boolean) est requis.' });
    return;
  }
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  const status = platform.setSuspended(meta.id, suspended);
  res.json(status);
});

platformRouter.get('/contact-messages', (_req, res) => {
  res.json({ messages: contactMessages.list(), unreadCount: contactMessages.unreadCount() });
});

platformRouter.patch('/contact-messages/:id/read', (req, res) => {
  const { read } = req.body as { read?: boolean };
  if (typeof read !== 'boolean') {
    res.status(400).json({ error: 'read (boolean) est requis.' });
    return;
  }
  const updated = contactMessages.setRead(req.params.id, read);
  if (!updated) {
    res.status(404).json({ error: 'Message introuvable.' });
    return;
  }
  res.json(updated);
});
