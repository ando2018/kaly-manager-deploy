import { NextFunction, Request, Response, Router } from 'express';
import {
  KALY_APP_ID,
  PlanDurationUnit,
  SubscriptionPlanDef,
  SubscriptionToken,
  TokenError,
  UNIT_IN_DAYS,
  subscriptions,
  tokenAppId,
} from '../data/subscriptions';
import { platform } from '../data/platform';
import { DirectionPinError, ONLINE_PAYMENT_OFF, PurchaseError, checkDirectionPin, kalyPurchase, requirePlatformKey } from './platform.routes';
import { config } from '../config';
import { contactMessages } from '../data/contact-messages';
import { isSmtpConfigured, notifyNewContactMessage, sendSubscriptionPurchaseMail, sendTokenRequestAckMail } from '../services/mail.service';
import { asyncHandler } from '../utils/async-handler';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;

/**
 * Token management shared by every application on this backend (Kaly Manager and others).
 * - Management (the token-manager app): X-Platform-Key.
 * - An application's own server: X-App-Key (its secret) to redeem; checking a code is public.
 */
export const tokensRouter = Router();

/** Runs a handler and turns a TokenError into its status + message. */
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof TokenError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

// ---------- Public / per-application ----------

/** Public — how the subscription screens let people subscribe: online payment, or a token request by e-mail. */
tokensRouter.get('/settings', (_req, res) => {
  res.json({ onlinePayment: config.onlinePayment });
});

/**
 * Public — a token request by e-mail for one plan (while online payment is on standby). Lands in /ap >
 * Messages and in the platform's notification e-mail; the requester gets an acknowledgment. Kaly Manager:
 * the e-mail defaults to the établissement's own.
 */
tokensRouter.post(
  '/apps/:appId/request',
  asyncHandler(async (req, res) => {
    const body = req.body as { holderId?: string; plan?: string; name?: string; email?: string; phone?: string; message?: string };
    let app;
    try {
      app = subscriptions.getApp(req.params.appId);
    } catch (err) {
      if (err instanceof TokenError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    const def = body.plan ? subscriptions.findPlan(body.plan, app.id) : undefined;
    if (!def || !def.active) {
      res.status(400).json({ error: 'Formule indisponible.' });
      return;
    }
    const rawId = body.holderId?.trim() ?? '';
    let holderId = rawId;
    let holderName: string | undefined;
    let email = body.email?.trim() ?? '';
    if (app.id === KALY_APP_ID) {
      const meta = platform.findEtablissement(rawId);
      if (!meta || meta.archived) {
        res.status(404).json({ error: "Identifiant d'établissement inconnu." });
        return;
      }
      holderId = meta.id;
      holderName = meta.name;
      if (!email && meta.adminEmail) email = meta.adminEmail;
    } else if (!HOLDER_RE.test(rawId)) {
      res.status(400).json({ error: "Indiquez l'identifiant de l'entreprise." });
      return;
    }
    const name = body.name?.trim() ?? '';
    if (!name) {
      res.status(400).json({ error: 'Indiquez votre nom.' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'Indiquez une adresse e-mail valide : le token y sera envoyé.' });
      return;
    }
    const duration = subscriptions.durationLabel(def);
    const holderLabel = holderName ? `${holderName} (${holderId})` : holderId;
    const extra = body.message?.trim();
    const message = [
      `Demande de token ${app.name} — forfait « ${def.label} » (${duration}, ${def.price.toFixed(2).replace('.', ',')} €)`,
      `Pour : ${holderLabel}`,
      ...(extra ? ['', extra.slice(0, 1000)] : []),
    ].join('\n');
    const created = contactMessages.create({
      name: name.slice(0, 120),
      email,
      phone: (body.phone?.trim() ?? '').slice(0, 40),
      message,
      etablissementIdAttempt: app.id === KALY_APP_ID ? holderId : undefined,
      etablissementName: holderName,
    });
    notifyNewContactMessage(created);

    let acknowledgedTo: string | null = null;
    if (isSmtpConfigured()) {
      try {
        await sendTokenRequestAckMail(email, { appName: app.name, holderLabel, planLabel: def.label, duration, price: def.price });
        acknowledgedTo = email;
      } catch (err) {
        console.error('Accusé de réception non envoyé :', err instanceof Error ? err.message : err);
      }
    }
    res.status(201).json({ ok: true, plan: def.label, holderId, acknowledgedTo });
  }),
);

/** Public — the subscription page (token-manager root): every application that sells at least one plan. */
tokensRouter.get(
  '/catalog',
  handle((_req, res) => {
    res.json(
      subscriptions
        .listApps()
        .map((a) => ({ id: a.id, name: a.name, prefix: a.prefix, plans: a.plans.filter((p) => p.active) }))
        .filter((a) => a.plans.length),
    );
  }),
);

/** What the subscription page shows about a company id in one application. */
function holderInfo(appId: string, holderId: string) {
  if (appId === KALY_APP_ID) {
    const meta = platform.findEtablissement(holderId);
    const status = meta && platform.subscriptionStatus(meta.id);
    if (!meta || !status || meta.archived) throw new TokenError("Identifiant d'établissement inconnu.", 404);
    return {
      holderId: meta.id,
      name: meta.name,
      // Has it ever had a subscription? (a brand-new établissement hasn't — it isn't « expired »)
      known: platform.accessPeriods(meta.id).length > 0,
      active: status.active,
      accessUntil: status.accessUntil,
      needsEmail: !meta.adminEmail,
      needsDirectionPin: true,
    };
  }
  if (!HOLDER_RE.test(holderId)) throw new TokenError('Identifiant invalide (lettres, chiffres, . _ -).');
  const access = subscriptions.holderAccess(appId, holderId);
  return {
    holderId,
    known: access.tokens.length > 0,
    active: access.active,
    accessUntil: access.accessUntil,
    needsEmail: false,
    needsDirectionPin: false,
  };
}

/**
 * Public — the subscription page's entry point: finds which organisation (and application) a company id
 * belongs to. Kaly Manager knows its établissements; another application knows an id once a token has
 * been attached to it. Usually one match — several when the same id is a customer of several applications.
 */
tokensRouter.get(
  '/holders/:holderId',
  handle((req, res) => {
    const raw = req.params.holderId.trim();
    if (!raw) throw new TokenError("Indiquez l'identifiant de l'entreprise.");
    const matches: unknown[] = [];
    for (const app of subscriptions.listApps()) {
      const plans = app.plans.filter((p) => p.active);
      if (!plans.length) continue;
      let holderId: string | undefined;
      if (app.id === KALY_APP_ID) {
        const meta = platform.findEtablissement(raw);
        if (meta && !meta.archived) holderId = meta.id;
      } else {
        const wanted = raw.toLowerCase();
        const token = subscriptions.listTokens(app.id).find((t) => t.usedAt && (t.usedBy ?? '').toLowerCase() === wanted);
        holderId = token?.usedBy;
      }
      if (!holderId) continue;
      matches.push({
        app: { id: app.id, name: app.name, prefix: app.prefix, plans },
        holder: holderInfo(app.id, holderId),
      });
    }
    if (!matches.length) throw new TokenError('Aucune organisation trouvée pour cet identifiant.', 404);
    res.json(matches);
  }),
);

/**
 * Public — the subscription page's Direction sign-in (Kaly Manager): checks the Direction PIN before showing
 * the plans. Purchases still send the PIN and check it again (the page keeps it in memory only).
 * Other applications have no Direction accounts here: nothing to sign in to.
 */
tokensRouter.post(
  '/apps/:appId/holders/:holderId/direction-login',
  asyncHandler(async (req, res) => {
    if (req.params.appId !== KALY_APP_ID) {
      res.status(400).json({ error: "Cette application n'a pas de compte Direction." });
      return;
    }
    const meta = platform.findEtablissement(req.params.holderId);
    if (!meta || meta.archived) {
      res.status(404).json({ error: "Identifiant d'établissement inconnu." });
      return;
    }
    const pin = String((req.body as { pin?: unknown }).pin ?? '').trim();
    try {
      const name = await checkDirectionPin(meta.id, pin);
      if (!name) {
        res.status(401).json({ error: 'Code PIN Direction incorrect.' });
        return;
      }
      res.json({ ok: true, name });
    } catch (err) {
      if (err instanceof DirectionPinError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

/** Public — a company id in one given application (also one that has no token yet: links ?app=…&id=…). */
tokensRouter.get(
  '/apps/:appId/holders/:holderId',
  handle((req, res) => {
    const app = subscriptions.getApp(req.params.appId);
    res.json(holderInfo(app.id, req.params.holderId.trim()));
  }),
);

/**
 * Public — buys a plan for a company id: the token is created and attached to that id straight away.
 * Payment is still SIMULATED. Kaly Manager: same rules as its own subscription screen (Direction PIN,
 * établissement e-mail). Other applications: the e-mail is optional and only receives the token.
 */
tokensRouter.post(
  '/apps/:appId/purchase',
  asyncHandler(async (req, res) => {
    const { holderId, plan, email } = req.body as { holderId?: string; plan?: string; email?: string };
    let app;
    try {
      app = subscriptions.getApp(req.params.appId);
    } catch (err) {
      if (err instanceof TokenError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (!config.onlinePayment) {
      res.status(403).json({ error: ONLINE_PAYMENT_OFF });
      return;
    }
    const id = holderId?.trim() ?? '';
    if (app.id === KALY_APP_ID) {
      try {
        const r = await kalyPurchase(req, id, plan, email);
        res.json({
          tokenCode: r.tokenCode,
          plan: r.plan,
          holderId: id.toUpperCase(),
          accessUntil: r.status.accessUntil,
          emailedTo: r.emailedTo,
          emailError: r.emailError,
        });
      } catch (err) {
        if (err instanceof PurchaseError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    if (!HOLDER_RE.test(id)) {
      res.status(400).json({ error: "Indiquez l'identifiant de l'entreprise (lettres, chiffres, . _ -)." });
      return;
    }
    const to = email?.trim();
    if (to && !EMAIL_RE.test(to)) {
      res.status(400).json({ error: 'Adresse e-mail invalide.' });
      return;
    }
    const def = plan ? subscriptions.findPlan(plan, app.id) : undefined;
    let token;
    try {
      token = subscriptions.purchase(app.id, plan ?? '', id, `Paiement en ligne (simulé) — ${id}`);
    } catch (err) {
      if (err instanceof TokenError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    const access = subscriptions.holderAccess(app.id, id);
    let emailedTo: string | null = null;
    let emailError: string | null = null;
    if (to) {
      if (!isSmtpConfigured()) {
        emailError = "L'envoi d'e-mails n'est pas configuré sur le serveur.";
      } else {
        try {
          await sendSubscriptionPurchaseMail(to, {
            appName: app.name,
            etablissementName: id,
            etablissementId: id,
            planLabel: def!.label,
            duration: subscriptions.durationLabel(def!),
            price: def!.price,
            tokenCode: token.code,
            purchasedAt: new Date(),
            accessUntil: new Date(access.accessUntil ?? Date.now()),
          });
          emailedTo = to;
        } catch (err) {
          emailError = "L'e-mail n'a pas pu être envoyé.";
          console.error('Envoi du token par e-mail impossible :', err instanceof Error ? err.message : err);
        }
      }
    }
    res.json({ tokenCode: token.code, plan: def!.label, holderId: id, accessUntil: access.accessUntil, emailedTo, emailError });
  }),
);

/** Public — the active plans an application's subscription screen offers. */
tokensRouter.get(
  '/apps/:appId/plans',
  handle((req, res) => {
    res.json(subscriptions.activePlans(req.params.appId));
  }),
);

/** Public — whether a code is still redeemable in this application (does not use it). */
tokensRouter.post(
  '/apps/:appId/check',
  handle((req, res) => {
    const code = String((req.body as { code?: string }).code ?? '');
    const result = subscriptions.checkToken(code, subscriptions.getApp(req.params.appId).id);
    res.json({
      valid: result.valid,
      reason: result.reason,
      plan: result.token?.plan,
      planLabel: result.token?.planLabel,
      days: result.token ? subscriptions.daysFor(result.token) : undefined,
    });
  }),
);

/** An application's server redeems one of its tokens for one of its customers (X-App-Key required).
 * Kaly Manager doesn't use this: its gate redeems through /api/platform (Direction check + access chain). */
tokensRouter.post(
  '/apps/:appId/redeem',
  handle((req, res) => {
    const { appId } = req.params;
    if (appId === KALY_APP_ID) {
      throw new TokenError("Kaly Manager active ses tokens depuis son propre écran d'abonnement.", 400);
    }
    if (!subscriptions.checkApiKey(appId, req.header('x-app-key'))) {
      res.status(401).json({ error: "Clé d'application invalide." });
      return;
    }
    const { code, holderId } = req.body as { code?: string; holderId?: string };
    if (!code?.trim() || !holderId?.trim()) throw new TokenError('code et holderId sont requis.');
    const token = subscriptions.redeemToken(code, holderId.trim().slice(0, 120), appId);
    res.json({ ...publicToken(token), days: subscriptions.daysFor(token) });
  }),
);

function publicToken(t: SubscriptionToken) {
  return {
    code: t.code,
    appId: tokenAppId(t),
    plan: t.plan,
    planLabel: t.planLabel,
    usedAt: t.usedAt,
    usedBy: t.usedBy ?? t.usedByEtablissementId,
  };
}

// ---------- Management (token-manager) ----------

tokensRouter.use(requirePlatformKey);

/** Lets the token-manager check its key. */
tokensRouter.get('/session', (_req, res) => {
  res.json({ ok: true });
});

tokensRouter.get(
  '/apps',
  handle((_req, res) => {
    const tokens = subscriptions.listTokens();
    res.json(
      subscriptions.listApps().map((app) => {
        const own = tokens.filter((t) => tokenAppId(t) === app.id);
        return {
          ...app,
          tokenCount: own.length,
          usedCount: own.filter((t) => t.usedAt).length,
        };
      }),
    );
  }),
);

tokensRouter.post(
  '/apps',
  handle((req, res) => {
    res.status(201).json(subscriptions.createApp(req.body as { id?: string; name?: string; prefix?: string }));
  }),
);

tokensRouter.patch(
  '/apps/:appId',
  handle((req, res) => {
    res.json(subscriptions.updateApp(req.params.appId, req.body as { name?: string; prefix?: string }));
  }),
);

tokensRouter.post(
  '/apps/:appId/api-key',
  handle((req, res) => {
    res.json(subscriptions.regenerateApiKey(req.params.appId));
  }),
);

tokensRouter.delete(
  '/apps/:appId',
  handle((req, res) => {
    subscriptions.deleteApp(req.params.appId);
    res.json({ ok: true });
  }),
);

/** Every plan of the application, inactive included. */
tokensRouter.get(
  '/apps/:appId/plans/all',
  handle((req, res) => {
    res.json(subscriptions.listPlans(req.params.appId));
  }),
);

const PLAN_ID_RE = /^[A-Z0-9_]{1,30}$/;

/** Replaces the application's plan list. Informational prices — no payment processing yet. */
tokensRouter.put(
  '/apps/:appId/plans',
  handle((req, res) => {
    const raw = (req.body as { plans?: unknown }).plans;
    if (!Array.isArray(raw) || raw.length === 0) throw new TokenError('Au moins une formule est requise.');
    const plans: SubscriptionPlanDef[] = [];
    const ids = new Set<string>();
    for (const item of raw as Record<string, unknown>[]) {
      const id = String(item.id ?? '').trim().toUpperCase();
      const label = String(item.label ?? '').trim();
      // Duration: amount × unit (minutes / heures / jours); a plan sent with `days` only is in days.
      const unit: PlanDurationUnit = item.unit === 'MINUTES' || item.unit === 'HOURS' ? item.unit : 'DAYS';
      const amount = Number(item.amount ?? item.days);
      const days = amount * UNIT_IN_DAYS[unit];
      const price = Number(item.price);
      if (!PLAN_ID_RE.test(id) || ids.has(id)) {
        throw new TokenError(`Identifiant de formule invalide ou en double : « ${id || '(vide)'} ».`);
      }
      if (!label) throw new TokenError(`La formule ${id} doit avoir un libellé.`);
      if (!Number.isInteger(amount) || amount < 1 || days > 3650) {
        throw new TokenError(`Durée invalide pour « ${label} » (un nombre entier, 10 ans maximum).`);
      }
      if (!Number.isFinite(price) || price < 0) throw new TokenError(`Prix invalide pour « ${label} ».`);
      ids.add(id);
      const description = String(item.description ?? '').trim();
      const compareAt = Number(item.compareAtPrice);
      const highlight = String(item.highlight ?? '').trim();
      plans.push({
        id,
        label: label.slice(0, 40),
        amount,
        unit,
        days,
        price: Math.round(price * 100) / 100,
        description: description ? description.slice(0, 200) : undefined,
        // A struck-through price only makes sense above the real one.
        compareAtPrice: Number.isFinite(compareAt) && compareAt > price ? Math.round(compareAt * 100) / 100 : undefined,
        highlight: highlight ? highlight.slice(0, 60) : undefined,
        featured: item.featured === true || undefined,
        active: item.active !== false,
      });
    }
    if (!plans.some((p) => p.active)) throw new TokenError('Au moins une formule doit être active.');
    res.json(subscriptions.setPlans(plans, req.params.appId));
  }),
);

/** Tokens, newest first — `?appId=` for one application. Kaly Manager's carry the établissement name. */
tokensRouter.get(
  '/',
  handle((req, res) => {
    const appId = typeof req.query.appId === 'string' && req.query.appId ? req.query.appId : undefined;
    const names = new Map(platform.listEtablissements().map((e) => [e.id, e.name]));
    res.json(
      subscriptions.listTokens(appId).map((t) => {
        const usedBy = t.usedBy ?? t.usedByEtablissementId;
        return {
          ...t,
          appId: tokenAppId(t),
          usedBy,
          usedByName: tokenAppId(t) === KALY_APP_ID && usedBy ? names.get(usedBy) : undefined,
        };
      }),
    );
  }),
);

/** Generates fresh, unused tokens for one plan of one application. */
tokensRouter.post(
  '/',
  handle((req, res) => {
    const { appId, plan, count, paid, note } = req.body as {
      appId?: string;
      plan?: string;
      count?: number;
      paid?: boolean;
      note?: string;
    };
    const app = subscriptions.getApp(appId || KALY_APP_ID);
    if (!plan || !subscriptions.findPlan(plan, app.id)) throw new TokenError('Formule inconnue.');
    const n = Number(count ?? 1);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new TokenError('count doit être un entier entre 1 et 100.');
    res.status(201).json(subscriptions.generateTokens(plan, n, Boolean(paid), note, app.id));
  }),
);

/** Revokes or restores a token. A revoked Kaly Manager token stops giving its établissement time. */
tokensRouter.patch(
  '/:code',
  handle((req, res) => {
    const { revoked } = req.body as { revoked?: boolean };
    res.json(subscriptions.setRevoked(req.params.code, Boolean(revoked)));
  }),
);

/** Removes a token, used or not (a redeemed Kaly Manager token stops counting — see platform.ts). */
tokensRouter.delete(
  '/:code',
  handle((req, res) => {
    subscriptions.deleteToken(req.params.code);
    res.json({ ok: true });
  }),
);
