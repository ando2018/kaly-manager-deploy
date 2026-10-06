import fs from 'node:fs';
import path from 'node:path';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import {
  isMailConfigured,
  isSmtpConfigured,
  notifyNewContactMessage,
  sendMail,
  sendPinResetMail,
  sendSubscriptionPurchaseMail,
} from '../services/mail.service';
import { config } from '../config';
import { SubscriptionStatus, platform } from '../data/platform';
import { buildDemoSeed } from '../data/db';
import { ContactMessageError, contactMessages } from '../data/contact-messages';
import { ensureEtablissementContext, evictEtablissementContext } from '../data/etablissement-registry';
import {
  clearFirebaseServiceAccount,
  getFirebaseProjectId,
  isFirebaseConfigured,
  setFirebaseServiceAccount,
} from '../data/firebase-admin';
import { StorageBackend } from '../data/platform';
import { SubscriptionPlan, subscriptions } from '../data/subscriptions';
import { deleteLibraryImage, etablissementUploadsDir, libraryImageUpload, listImageLibrary } from '../middleware/upload.middleware';
import { broadcastUsers } from '../sockets/io';
import { asyncHandler } from '../utils/async-handler';
import bcrypt from 'bcryptjs';
import { verifyToken } from '../services/auth.service';

const ETABLISSEMENTS_DATA_ROOT = path.resolve(__dirname, '..', '..', 'data', 'etablissements');

export const platformRouter = Router();

export function requirePlatformKey(req: Request, res: Response, next: NextFunction): void {
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
  res.json(subscriptions.activePlans());
});

/**
 * Only the Direction subscribes: either signed in as this établissement's ADMIN (Bearer token, in the app),
 * or — on the subscription gate, before anyone can sign in — by giving a Direction account's PIN.
 */
/** Wrong Direction PINs per établissement: 5 in a row lock PIN checks for 10 minutes (a 4-digit PIN is
 * otherwise quick to guess from the public subscription screens). */
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 10 * 60 * 1000;
const pinFailures = new Map<string, { count: number; lockedUntil: number }>();

export class DirectionPinError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Checks a Direction (active ADMIN) PIN of the établissement. Returns the Direction account's name, or
 * null for a wrong PIN; throws DirectionPinError (429) while locked after too many wrong PINs.
 */
export async function checkDirectionPin(etablissementId: string, pin: string): Promise<string | null> {
  const entry = pinFailures.get(etablissementId);
  if (entry && entry.lockedUntil > Date.now()) {
    const minutes = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    throw new DirectionPinError(`Trop de codes erronés : réessayez dans ${minutes} min.`, 429);
  }
  if (!/^\d{4}$/.test(pin)) return null;
  const context = await ensureEtablissementContext(etablissementId).catch(() => undefined);
  const user = context?.db.data.users.find((u) => u.role === 'ADMIN' && !u.suspended && bcrypt.compareSync(pin, u.pinHash));
  if (user) {
    pinFailures.delete(etablissementId);
    return user.name;
  }
  const count = (entry && entry.lockedUntil <= Date.now() && entry.count >= PIN_MAX_FAILURES ? 0 : (entry?.count ?? 0)) + 1;
  pinFailures.set(etablissementId, { count, lockedUntil: count >= PIN_MAX_FAILURES ? Date.now() + PIN_LOCK_MS : 0 });
  return null;
}

async function isDirection(req: Request, etablissementId: string): Promise<boolean> {
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const payload = bearer ? verifyToken(bearer) : null;
  if (payload && payload.role === 'ADMIN' && payload.etablissementId === etablissementId) return true;
  const pin = String((req.body as { adminPin?: unknown })?.adminPin ?? '').trim();
  if (!pin) return false;
  return (await checkDirectionPin(etablissementId, pin)) !== null;
}

const DIRECTION_ONLY = "Seule la direction peut s'abonner : connectez-vous avec un compte Direction ou saisissez son code PIN.";

/** Public — an établissement's own staff redeem a token here to unlock/extend access, no platform key needed. */
platformRouter.post('/etablissements/:id/subscription/redeem', asyncHandler(async (req, res) => {
  const meta = platform.findEtablissement(req.params.id);
  if (!meta) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  try {
    if (!(await isDirection(req, meta.id))) {
      res.status(403).json({ error: DIRECTION_ONLY });
      return;
    }
  } catch (err) {
    if (err instanceof DirectionPinError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { tokenCode } = req.body as { tokenCode?: string };
  if (!tokenCode?.trim()) {
    res.status(400).json({ error: 'tokenCode est requis.' });
    return;
  }
  try {
    const token = subscriptions.redeemToken(tokenCode, meta.id);
    const def = subscriptions.findPlan(token.plan);
    const status = platform.extendSubscription(meta.id, {
      source: 'TOKEN',
      plan: token.plan,
      days: subscriptions.daysFor(token),
      tokenCode: token.code,
      planLabel: token.planLabel ?? def?.label,
      durationLabel: def ? subscriptions.durationLabel(def) : undefined,
    });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Token invalide.' });
  }
}));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public — « Payer en ligne » from the subscription screen (gate or in-app). The online payment is still
 * SIMULATED: this creates a token for the chosen plan, redeems it for the établissement straight away and
 * e-mails it to the Direction's address. Until a real payment provider is plugged in, anyone reaching
 * this screen can activate a plan without paying.
 */
export const ONLINE_PAYMENT_OFF = 'Le paiement en ligne est momentanément indisponible : demandez votre token par e-mail.';

export interface KalyPurchaseResult {
  status: SubscriptionStatus;
  tokenCode: string;
  plan: string;
  emailedTo: string | null;
  emailError: string | null;
}

/** Thrown by kalyPurchase — the HTTP status and message to answer with. */
export class PurchaseError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Kaly Manager's online purchase (subscription screen, gate, or the token-manager's public page). Payment is
 * still SIMULATED: the Direction check stands in for it. Creates a token for the plan, redeems it for the
 * établissement straight away, extends its access and e-mails the token with a recap.
 */
export async function kalyPurchase(
  req: Request,
  etablissementId: string,
  plan: string | undefined,
  email: string | undefined,
): Promise<KalyPurchaseResult> {
  if (!config.onlinePayment) throw new PurchaseError(ONLINE_PAYMENT_OFF, 403);
  const meta = platform.findEtablissement(etablissementId);
  if (!meta) throw new PurchaseError("Identifiant d'établissement inconnu.", 404);
  let direction: boolean;
  try {
    direction = await isDirection(req, meta.id);
  } catch (err) {
    if (err instanceof DirectionPinError) throw new PurchaseError(err.message, err.status);
    throw err;
  }
  if (!direction) throw new PurchaseError(DIRECTION_ONLY, 403);
  const def = plan ? subscriptions.findPlan(plan) : undefined;
  if (!def || !def.active) throw new PurchaseError('Formule indisponible.', 400);
  // The token and the receipt go to the établissement's e-mail — asked for here when none is on file yet.
  if (!meta.adminEmail) {
    const given = email?.trim();
    if (!given || !EMAIL_RE.test(given)) {
      throw new PurchaseError("Indiquez l'adresse e-mail de l'établissement : le token y sera envoyé.", 400);
    }
    platform.setAdminEmail(meta.id, given);
  }
  const to = platform.findEtablissement(meta.id)!.adminEmail!;

  const [token] = subscriptions.generateTokens(def.id, 1, true, `Paiement en ligne (simulé) — ${meta.name}`);
  subscriptions.redeemToken(token.code, meta.id);
  const status = platform.extendSubscription(meta.id, {
    source: 'TOKEN',
    plan: def.id,
    days: subscriptions.daysFor(token),
    tokenCode: token.code,
    planLabel: def.label,
    durationLabel: subscriptions.durationLabel(def),
    price: def.price,
    purchase: true,
  });

  let emailedTo: string | null = null;
  let emailError: string | null = null;
  if (isSmtpConfigured()) {
    const origin = req.get('origin');
    try {
      await sendSubscriptionPurchaseMail(to, {
        etablissementName: meta.name,
        etablissementId: meta.id,
        planLabel: def.label,
        duration: subscriptions.durationLabel(def),
        price: def.price,
        tokenCode: token.code,
        purchasedAt: new Date(),
        accessUntil: new Date(status.accessUntil),
        link: origin ? `${origin}/etablissement/${meta.id}` : undefined,
      });
      emailedTo = to;
    } catch (err) {
      emailError = "L'e-mail n'a pas pu être envoyé.";
      console.error('Envoi du token par e-mail impossible :', err instanceof Error ? err.message : err);
    }
  } else {
    emailError = "L'envoi d'e-mails n'est pas configuré sur le serveur.";
  }
  return { status, tokenCode: token.code, plan: def.label, emailedTo, emailError };
}

/**
 * Public — « Payer en ligne » from the subscription screen (gate or in-app). The online payment is still
 * SIMULATED (see kalyPurchase): until a real payment provider is plugged in, the Direction can activate a
 * plan without paying.
 */
platformRouter.post(
  '/etablissements/:id/subscription/purchase',
  asyncHandler(async (req, res) => {
    const { plan, email } = req.body as { plan?: SubscriptionPlan; email?: string };
    try {
      res.json(await kalyPurchase(req, req.params.id, plan, email));
    } catch (err) {
      if (err instanceof PurchaseError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

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
  notifyNewContactMessage(created);
  res.status(201).json(created);
});

platformRouter.use(requirePlatformKey);

/** Whether outgoing notification e-mails are set up (SMTP_HOST + NOTIFY_EMAIL in backend/.env). */
platformRouter.get('/mail/status', (_req, res) => {
  res.json({
    configured: isMailConfigured(),
    host: config.smtp.host ?? null,
    to: config.notifyEmail ?? null,
    // What's missing, to say exactly what to fix in /ap.
    envFile: config.envFile.path,
    envLoaded: config.envFile.loaded,
    missing: [
      !config.smtp.host && 'SMTP_HOST',
      !config.smtp.user && 'SMTP_USER',
      !config.smtp.pass && 'SMTP_PASS',
      !config.notifyEmail && 'NOTIFY_EMAIL',
    ].filter(Boolean),
  });
});

/** Sends a test e-mail to NOTIFY_EMAIL so the SMTP settings can be checked from /ap. */
platformRouter.post(
  '/mail/test',
  asyncHandler(async (_req, res) => {
    if (!isMailConfigured()) {
      res.status(400).json({ error: 'SMTP non configuré : renseignez SMTP_HOST et NOTIFY_EMAIL dans backend/.env puis redémarrez le serveur.' });
      return;
    }
    try {
      await sendMail(
        config.notifyEmail!,
        '[Kaly Manager] E-mail de test',
        "Si vous lisez ce message, l'envoi d'e-mails de Kaly Manager fonctionne.",
      );
      res.json({ ok: true, to: config.notifyEmail });
    } catch (err) {
      res.status(502).json({ error: `Échec de l'envoi : ${err instanceof Error ? err.message : err}` });
    }
  }),
);

platformRouter.get('/etablissements', (_req, res) => {
  res.json(platform.listEtablissements());
});

platformRouter.post('/etablissements', (req, res) => {
  const { name, adminName, adminEmail } = req.body as { name?: string; adminName?: string; adminEmail?: string };
  if (!name?.trim() || !adminName?.trim()) {
    res.status(400).json({ error: "name et adminName sont requis." });
    return;
  }
  if (adminEmail?.trim() && !EMAIL_RE.test(adminEmail.trim())) {
    res.status(400).json({ error: "Adresse e-mail de l'administrateur invalide." });
    return;
  }
  const meta = platform.createEtablissement(name, adminName, adminEmail);
  res.status(201).json(meta);
});

/** Sets (or clears, with an empty value) the e-mail used to write to this établissement's admin. */
platformRouter.patch('/etablissements/:id/admin-email', (req, res) => {
  const { adminEmail } = req.body as { adminEmail?: string };
  if (adminEmail?.trim() && !EMAIL_RE.test(adminEmail.trim())) {
    res.status(400).json({ error: 'Adresse e-mail invalide.' });
    return;
  }
  if (!platform.findEtablissement(req.params.id)) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  res.json(platform.setAdminEmail(req.params.id, adminEmail));
});

// ---- Bibliothèque d'images produits (shared by every établissement, served from /image-library) ----

platformRouter.get('/image-library', (_req, res) => {
  res.json(listImageLibrary());
});

/** One or several images (field « images »); an optional « name » names a single upload. */
platformRouter.post('/image-library', (req, res) => {
  libraryImageUpload.array('images', 20)(req, res, (err: unknown) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'Image trop lourde (5 Mo maximum).'
          : err instanceof Error
            ? err.message
            : "Échec de l'envoi.";
      res.status(400).json({ error: message });
      return;
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) {
      res.status(400).json({ error: 'Aucune image reçue.' });
      return;
    }
    const added = new Set(files.map((f) => f.filename));
    res.status(201).json(listImageLibrary().filter((img) => added.has(img.file)));
  });
});

platformRouter.delete('/image-library/:file', (req, res) => {
  if (!deleteLibraryImage(req.params.file)) {
    res.status(404).json({ error: 'Image introuvable.' });
    return;
  }
  res.status(204).send();
});

// The guide PDF is built in the browser (it embeds the app's own screenshots), then handed over here
// only to be mailed — kept in memory, never written to disk.
const guideUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

/** Manually e-mails the user guide (PDF attached) to the établissement's admin address. */
platformRouter.post(
  '/etablissements/:id/send-guide',
  guideUpload.single('guide'),
  asyncHandler(async (req, res) => {
    const meta = platform.findEtablissement(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    if (!meta.adminEmail) {
      res.status(400).json({ error: "Aucune adresse e-mail n'est renseignée pour l'administrateur de cet établissement." });
      return;
    }
    if (!isSmtpConfigured()) {
      res.status(400).json({ error: "L'envoi d'e-mails n'est pas configuré (SMTP dans backend/.env)." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Guide PDF manquant.' });
      return;
    }
    const link = `${req.protocol}://${req.get('host')}/etablissement/${meta.id}`;
    const text = [
      `Bonjour${meta.adminName ? ` ${meta.adminName}` : ''},`,
      '',
      `Votre établissement « ${meta.name} » est prêt sur Kaly Manager.`,
      '',
      `Identifiant de l'établissement : ${meta.id}`,
      `Connexion directe : ${link}`,
      '',
      "Vous trouverez en pièce jointe le manuel d'utilisation : premiers pas, création de votre premier service,",
      "ajout de votre logo, gestion de l'équipe, des évènements, du stock, des commandes et de la caisse.",
      '',
      'Pour toute question, répondez simplement à cet e-mail.',
      '',
      "L'équipe Kaly Manager",
    ].join('\n');
    try {
      await sendMail(
        meta.adminEmail,
        `Kaly Manager — Guide d'utilisation de ${meta.name}`,
        text,
        config.notifyEmail?.split(',')[0]?.trim() || undefined,
        [
          {
            filename: req.file.originalname || `Manuel-KalyManager-${meta.id}.pdf`,
            content: req.file.buffer,
            contentType: 'application/pdf',
          },
        ],
      );
      res.json({ ok: true, to: meta.adminEmail });
    } catch (err) {
      res.status(502).json({ error: `Échec de l'envoi : ${err instanceof Error ? err.message : err}` });
    }
  }),
);

/**
 * Creates a permanent, non-deletable établissement pre-seeded with a demo menu and one user per
 * role (WAITER/KITCHEN/CASHIER/ADMIN/COMPTOIR) — a standing sandbox for testing, never wiped out by
 * one-by-one cleanup elsewhere on the platform.
 */
platformRouter.post('/etablissements/test-base', (_req, res) => {
  const meta = platform.createEtablissement('Établissement de Test (toutes les rôles)', 'Admin Test');
  // Protected = standing sandbox, never gated behind a subscription (see statusFor).
  platform.setProtected(meta.id, true);

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
    subscriptions.deleteTokensUsedBy(meta.id);
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
    // The founding Direction account: the first active ADMIN (else the first ADMIN at all).
    const admins = context.db.data.users.filter((u) => u.role === 'ADMIN');
    const adminUser = admins.find((u) => !u.suspended) ?? admins[0];
    if (!adminUser) {
      res.status(404).json({ error: 'Aucun compte administrateur trouvé pour cet établissement.' });
      return;
    }
    const pinCode = generateRandomPin();
    const updated = context.users.resetPin(adminUser.id, pinCode);
    broadcastUsers(context.id);
    // A fresh PIN: wrong guesses of the old one no longer lock the Direction out.
    pinFailures.delete(context.id);

    // The provisional PIN goes to the établissement's e-mail (the Direction).
    const meta = platform.findEtablissement(context.id);
    let emailedTo: string | null = null;
    let emailError: string | null = null;
    if (!meta?.adminEmail) {
      emailError = "Aucun e-mail n'est enregistré pour cet établissement.";
    } else if (!isSmtpConfigured()) {
      emailError = "L'envoi d'e-mails n'est pas configuré sur le serveur.";
    } else {
      const origin = req.get('origin');
      try {
        await sendPinResetMail(meta.adminEmail, {
          etablissementName: meta.name,
          etablissementId: meta.id,
          userName: updated.name,
          pinCode,
          link: origin ? `${origin}/etablissement/${meta.id}` : undefined,
        });
        emailedTo = meta.adminEmail;
      } catch (err) {
        emailError = "L'e-mail n'a pas pu être envoyé.";
        console.error('Envoi du PIN provisoire impossible :', err instanceof Error ? err.message : err);
      }
    }
    res.json({ userId: updated.id, userName: updated.name, pinCode, emailedTo, emailError });
  }),
);

/** Lightweight cross-établissement dashboard: status, last activity, usage — no per-order/menu detail. */
platformRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const overview = await Promise.all(
      platform.listEtablissements().map(async (meta) => {
        const context = await ensureEtablissementContext(meta.id).catch((err) => {
          console.error(`Échec du chargement du contexte pour l'établissement ${meta.id}:`, err);
          return undefined;
        });
        return {
          id: meta.id,
          name: meta.name,
          adminName: meta.adminName ?? null,
          adminEmail: meta.adminEmail ?? null,
          archived: meta.archived ?? false,
          protected: meta.protected ?? false,
          createdAt: meta.createdAt,
          lastActivityAt: meta.lastActivityAt ?? null,
          storageBackend: meta.storageBackend ?? 'LOCAL',
          subscription: platform.subscriptionStatus(meta.id) ?? null,
          accessPeriods: platform.accessPeriods(meta.id),
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

/** Full subscription status + redemption history for one établissement — the platform admin's detail view. */
platformRouter.get('/etablissements/:id/subscription', (req, res) => {
  const detail = platform.subscriptionDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: "Identifiant d'établissement inconnu." });
    return;
  }
  res.json(detail);
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

platformRouter.patch('/contact-messages/:id/archive', (req, res) => {
  const { archived } = req.body as { archived?: boolean };
  if (typeof archived !== 'boolean') {
    res.status(400).json({ error: 'archived (boolean) est requis.' });
    return;
  }
  const updated = contactMessages.setArchived(req.params.id, archived);
  if (!updated) {
    res.status(404).json({ error: 'Message introuvable.' });
    return;
  }
  res.json(updated);
});

platformRouter.delete('/contact-messages/:id', (req, res) => {
  try {
    contactMessages.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ContactMessageError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
