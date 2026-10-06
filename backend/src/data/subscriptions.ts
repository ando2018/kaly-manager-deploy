import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PlatformDocStore } from './platform-doc-store';

/** A plan's id — the plans themselves are a platform setting (see SubscriptionPlanDef), not a fixed list. */
export type SubscriptionPlan = string;

/** One choice offered on the subscription screen and used to generate tokens — edited in /ap. */
export type PlanDurationUnit = 'MINUTES' | 'HOURS' | 'DAYS';

/** How many days one unit lasts — durations are applied in milliseconds, so fractions of a day are fine. */
export const UNIT_IN_DAYS: Record<PlanDurationUnit, number> = { MINUTES: 1 / 1440, HOURS: 1 / 24, DAYS: 1 };

export interface SubscriptionPlanDef {
  id: string;
  label: string;
  /** Duration as entered: `amount` × `unit` (e.g. 5 MINUTES). Absent on plans saved before units existed = days. */
  amount?: number;
  unit?: PlanDurationUnit;
  /** Same duration in days (may be a fraction: 5 min ≈ 0.0035) — what tokens and grants actually apply. */
  days: number;
  price: number;
  description?: string;
  /** « Prix barré »: shown struck through next to `price`, with the % saved. Only kept when above `price`. */
  compareAtPrice?: number;
  /** Short encouraging line shown on the plan card (« Économisez 30 € », « Idéal pour démarrer »…). */
  highlight?: string;
  /** Highlighted as « Le plus choisi » on the subscription screen. */
  featured?: boolean;
  /** Inactive plans are hidden from the subscription screen and token generation, but old tokens keep working. */
  active: boolean;
}

/** Durations of the plans that existed before plans became configurable — old tokens only store the id. */
const LEGACY_PLAN_DAYS: Record<string, number> = { DAY: 1, TWO_DAYS: 2, WEEK: 7, MONTH: 30, YEAR: 365 };

export const TRIAL_DAYS = 7;

/** Pre-configurable pricing (one price per fixed plan) — only read to seed the plan list once. */
interface LegacyPricing {
  TWO_DAYS?: number;
  WEEK?: number;
  MONTH?: number;
  YEAR?: number;
}

function defaultPlans(legacy: LegacyPricing = {}): SubscriptionPlanDef[] {
  return [
    { id: 'DAY', label: '1 jour', days: 1, price: 1, active: true, description: "Pour un besoin d'une journée — un événement, un marché, un test." },
    { id: 'TWO_DAYS', label: '2 jours', days: 2, price: legacy.TWO_DAYS ?? 2, active: true, description: "Pour un essai rapide ou un besoin très ponctuel — un week-end, un événement d'un jour ou deux." },
    { id: 'WEEK', label: 'Semaine', days: 7, price: legacy.WEEK ?? 5, active: true, description: 'Pour tester Kaly Manager ou couvrir un besoin ponctuel — événement, remplacement, saison courte.' },
    { id: 'MONTH', label: 'Mois', days: 30, price: legacy.MONTH ?? 15, active: true, featured: true, description: 'Le format le plus choisi — un usage régulier, sans engagement long.' },
    { id: 'YEAR', label: 'An', days: 365, price: legacy.YEAR ?? 120, active: true, description: 'Le tarif le plus avantageux — pour les établissements qui utilisent Kaly Manager au quotidien.' },
  ];
}

/** One application whose access is sold with tokens (Kaly Manager, and any other app on this backend). */
export interface TokenApp {
  /** Stable id used by the app's code, e.g. "kaly-manager". */
  id: string;
  name: string;
  /** Fixed first group of its tokens, e.g. "KAMA" → KAMA-XXXX-XXXX-XXXX-XXXX. */
  prefix: string;
  plans: SubscriptionPlanDef[];
  /** Secret the application's own server sends (X-App-Key) to redeem its tokens through /api/tokens. */
  apiKey?: string;
  createdAt: string;
}

function newApiKey(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Kaly Manager itself — created from the pre-existing plans the first time apps are read. */
export const KALY_APP_ID = 'kaly-manager';

export interface SubscriptionToken {
  code: string;
  /** Which application this token is for (absent on tokens made before apps existed = Kaly Manager). */
  appId?: string;
  plan: SubscriptionPlan;
  /** Snapshot at generation time — the token keeps its duration even if the plan is later edited or removed. */
  days?: number;
  planLabel?: string;
  createdAt: string;
  paid: boolean;
  note?: string;
  usedAt?: string;
  /** Who redeemed it, in its application's own terms (Kaly Manager: the établissement id). */
  usedBy?: string;
  /** Kaly Manager's field for the same thing — kept for its existing data and code. */
  usedByEtablissementId?: string;
  revoked?: boolean;
}

export class TokenError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface PricingShape {
  /** Legacy fixed-plan prices — kept only to seed Kaly Manager's plans once. */
  pricing?: LegacyPricing;
  /** Legacy single plan list (before apps) — moved into the Kaly Manager app once. */
  plans?: SubscriptionPlanDef[];
  apps?: TokenApp[];
}

interface TokensShape {
  tokens: SubscriptionToken[];
}

const PRICING_PATH = path.resolve(__dirname, '..', '..', 'data', 'subscription-pricing.json');
const TOKENS_PATH = path.resolve(__dirname, '..', '..', 'data', 'subscription-tokens.json');
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

let pricingStore: PlatformDocStore<PricingShape> | undefined;
let tokensStore: PlatformDocStore<TokensShape> | undefined;

/** Migrates any pre-existing local pricing/tokens JSON into the platform's Firestore project on first boot. Must resolve before any other export here is called. */
export async function initSubscriptionsStore(): Promise<void> {
  pricingStore = await PlatformDocStore.create<PricingShape>('subscription-pricing', () => {
    if (fs.existsSync(PRICING_PATH)) return JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8')) as PricingShape;
    return { plans: defaultPlans() };
  });
  if (fs.existsSync(PRICING_PATH)) fs.renameSync(PRICING_PATH, `${PRICING_PATH}.migrated`);

  tokensStore = await PlatformDocStore.create<TokensShape>('subscription-tokens', () => {
    if (fs.existsSync(TOKENS_PATH)) return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as TokensShape;
    return { tokens: [] };
  });
  if (fs.existsSync(TOKENS_PATH)) fs.renameSync(TOKENS_PATH, `${TOKENS_PATH}.migrated`);
}

function loadPricing(): PricingShape {
  if (!pricingStore) throw new Error('Subscriptions store not initialized — call initSubscriptionsStore() at server boot.');
  return pricingStore.data;
}

/** Every application; Kaly Manager is created from the existing plans (or defaults) the first time. */
function loadApps(): TokenApp[] {
  const data = loadPricing();
  if (!data.apps?.length) {
    data.apps = [
      {
        id: KALY_APP_ID,
        name: 'Kaly Manager',
        prefix: 'KAMA',
        plans: data.plans?.length ? data.plans : defaultPlans(data.pricing),
        apiKey: newApiKey(),
        createdAt: new Date().toISOString(),
      },
    ];
    savePricing(data);
  }
  return data.apps;
}

function findApp(appId: string): TokenApp {
  const app = loadApps().find((a) => a.id === appId);
  if (!app) throw new TokenError('Application inconnue.', 404);
  return app;
}

/** A plan list as served: unit filled in for old plans, shortest first. */
function normalizePlans(plans: SubscriptionPlanDef[]): SubscriptionPlanDef[] {
  return plans.map((p) => ({ ...p, unit: p.unit ?? 'DAYS', amount: p.amount ?? p.days })).sort((a, b) => a.days - b.days);
}

/** The application a token belongs to — tokens made before apps existed are Kaly Manager's. */
export function tokenAppId(token: Pick<SubscriptionToken, 'appId'>): string {
  return token.appId ?? KALY_APP_ID;
}

function savePricing(_data: PricingShape): void {
  pricingStore!.touch();
}

function loadTokens(): TokensShape {
  if (!tokensStore) throw new Error('Subscriptions store not initialized — call initSubscriptionsStore() at server boot.');
  return tokensStore.data;
}

function saveTokens(_data: TokensShape): void {
  tokensStore!.touch();
}

function randomGroup(length: number): string {
  return Array.from({ length }, () => TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)]).join('');
}

/** Format: "<PREFIX>-IRNA-QGBG-MYZ6-T6FQ" — the application's fixed prefix (Kaly Manager: KAMA), then 4
 * random groups. Older tokens ("TOK-…") stay valid: redemption only looks the code up. */
function generateTokenCode(prefix: string, existing: Set<string>): string {
  let code: string;
  do {
    code = `${prefix}-${Array.from({ length: 4 }, () => randomGroup(4)).join('-')}`;
  } while (existing.has(code));
  return code;
}

const PREFIX_RE = /^[A-Z0-9]{2,6}$/;
const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export const subscriptions = {
  // ---------- Applications ----------

  listApps(): TokenApp[] {
    return loadApps().map((a) => ({ ...a, plans: normalizePlans(a.plans) }));
  },

  getApp(appId: string): TokenApp {
    const app = findApp(appId);
    return { ...app, plans: normalizePlans(app.plans) };
  },

  createApp(input: { id?: string; name?: string; prefix?: string }): TokenApp {
    const name = input.name?.trim();
    const prefix = input.prefix?.trim().toUpperCase() ?? '';
    const id = (input.id?.trim().toLowerCase() || name?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) ?? '';
    if (!name) throw new TokenError("Le nom de l'application est requis.");
    if (!APP_ID_RE.test(id)) throw new TokenError('Identifiant invalide (lettres minuscules, chiffres et tirets).');
    if (!PREFIX_RE.test(prefix)) throw new TokenError('Préfixe invalide : 2 à 6 lettres majuscules ou chiffres.');
    const apps = loadApps();
    if (apps.some((a) => a.id === id)) throw new TokenError('Cet identifiant est déjà utilisé.');
    if (apps.some((a) => a.prefix === prefix)) throw new TokenError('Ce préfixe est déjà utilisé par une autre application.');
    const app: TokenApp = { id, name, prefix, plans: [], apiKey: newApiKey(), createdAt: new Date().toISOString() };
    apps.push(app);
    savePricing(loadPricing());
    return app;
  },

  updateApp(appId: string, input: { name?: string; prefix?: string }): TokenApp {
    const app = findApp(appId);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new TokenError("Le nom de l'application est requis.");
      app.name = name;
    }
    if (input.prefix !== undefined) {
      const prefix = input.prefix.trim().toUpperCase();
      if (!PREFIX_RE.test(prefix)) throw new TokenError('Préfixe invalide : 2 à 6 lettres majuscules ou chiffres.');
      if (loadApps().some((a) => a.id !== appId && a.prefix === prefix)) {
        throw new TokenError('Ce préfixe est déjà utilisé par une autre application.');
      }
      // Only new tokens use it: existing codes stay as they were (and valid).
      app.prefix = prefix;
    }
    savePricing(loadPricing());
    return this.getApp(appId);
  },

  /** A new secret for the application — the old one stops working immediately. */
  regenerateApiKey(appId: string): TokenApp {
    findApp(appId).apiKey = newApiKey();
    savePricing(loadPricing());
    return this.getApp(appId);
  },

  /** Whether `key` is this application's secret. */
  checkApiKey(appId: string, key: string | undefined): boolean {
    const app = loadApps().find((a) => a.id === appId);
    if (!app?.apiKey || !key) return false;
    const a = Buffer.from(app.apiKey);
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  /** Refused for Kaly Manager itself and for an application that still has tokens. */
  deleteApp(appId: string): void {
    if (appId === KALY_APP_ID) throw new TokenError("L'application Kaly Manager ne peut pas être supprimée.");
    findApp(appId);
    if (loadTokens().tokens.some((t) => tokenAppId(t) === appId)) {
      throw new TokenError("Supprimez d'abord les tokens de cette application.", 409);
    }
    const data = loadPricing();
    data.apps = loadApps().filter((a) => a.id !== appId);
    savePricing(data);
  },

  // ---------- Plans (per application; Kaly Manager by default) ----------

  /** Every plan (inactive included), shortest first. */
  listPlans(appId: string = KALY_APP_ID): SubscriptionPlanDef[] {
    return normalizePlans(findApp(appId).plans);
  },

  /** What a subscription screen offers. */
  activePlans(appId: string = KALY_APP_ID): SubscriptionPlanDef[] {
    return this.listPlans(appId).filter((p) => p.active);
  },

  findPlan(id: string, appId: string = KALY_APP_ID): SubscriptionPlanDef | undefined {
    return loadApps().find((a) => a.id === appId)?.plans.find((p) => p.id === id);
  },

  setPlans(plans: SubscriptionPlanDef[], appId: string = KALY_APP_ID): SubscriptionPlanDef[] {
    findApp(appId).plans = plans;
    savePricing(loadPricing());
    return this.listPlans(appId);
  },

  /** « 5 min », « 2 h », « 1 jour », « 30 jours ». */
  durationLabel(plan: SubscriptionPlanDef): string {
    const unit = plan.unit ?? 'DAYS';
    const amount = plan.amount ?? plan.days;
    if (unit === 'MINUTES') return `${amount} min`;
    if (unit === 'HOURS') return `${amount} h`;
    return amount === 1 ? '1 jour' : `${amount} jours`;
  },

  /** How long a token (or a plan id) grants — its own snapshot first, then the current plan, then legacy ids. */
  daysFor(token: Pick<SubscriptionToken, 'plan' | 'days' | 'appId'>): number {
    return token.days ?? this.findPlan(token.plan, tokenAppId(token))?.days ?? LEGACY_PLAN_DAYS[token.plan] ?? 0;
  },

  // ---------- Tokens ----------

  /** Newest first; one application's only when `appId` is given. */
  listTokens(appId?: string): SubscriptionToken[] {
    return loadTokens()
      .tokens.filter((t) => !appId || tokenAppId(t) === appId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  /** Generates `count` fresh, unused tokens for one plan of one application (Kaly Manager by default). */
  generateTokens(plan: SubscriptionPlan, count: number, paid: boolean, note?: string, appId: string = KALY_APP_ID): SubscriptionToken[] {
    const app = findApp(appId);
    const def = app.plans.find((p) => p.id === plan);
    if (!def) throw new TokenError('Formule inconnue.');
    const data = loadTokens();
    const existing = new Set(data.tokens.map((t) => t.code));
    const created: SubscriptionToken[] = [];
    for (let i = 0; i < count; i++) {
      const token: SubscriptionToken = {
        code: generateTokenCode(app.prefix, existing),
        appId,
        plan,
        days: def.days,
        planLabel: def.label,
        createdAt: new Date().toISOString(),
        paid,
        note: note?.trim() || undefined,
      };
      existing.add(token.code);
      data.tokens.push(token);
      created.push(token);
    }
    saveTokens(data);
    return created;
  },

  /** Whether a code can still be redeemed in this application — without using it. */
  checkToken(code: string, appId: string): { valid: boolean; reason?: string; token?: SubscriptionToken } {
    const token = loadTokens().tokens.find((t) => t.code === code.trim().toUpperCase());
    if (!token || tokenAppId(token) !== appId) return { valid: false, reason: 'Token introuvable pour cette application.' };
    if (token.revoked) return { valid: false, reason: 'Ce token a été révoqué.', token };
    if (token.usedAt) return { valid: false, reason: 'Ce token a déjà été utilisé.', token };
    return { valid: true, token };
  },

  /** Marks the token used by `holderId`. Refused for another application's, a used or a revoked token —
   * the caller then applies the actual access (Kaly Manager: platform.ts extendSubscription). */
  redeemToken(code: string, holderId: string, appId: string = KALY_APP_ID): SubscriptionToken {
    const data = loadTokens();
    const normalized = code.trim().toUpperCase();
    const token = data.tokens.find((t) => t.code === normalized);
    if (!token || tokenAppId(token) !== appId) throw new TokenError('Token introuvable.');
    if (token.revoked) throw new TokenError('Ce token a été révoqué.');
    if (token.usedAt) throw new TokenError('Ce token a déjà été utilisé.');
    token.usedAt = new Date().toISOString();
    token.usedBy = holderId;
    if (appId === KALY_APP_ID) token.usedByEtablissementId = holderId;
    saveTokens(data);
    return token;
  },

  /** Revokes (or restores) a token: a revoked token can't be redeemed, and a redeemed one stops giving time. */
  setRevoked(code: string, revoked: boolean): SubscriptionToken {
    const data = loadTokens();
    const token = data.tokens.find((t) => t.code === code);
    if (!token) throw new TokenError('Token introuvable.', 404);
    token.revoked = revoked || undefined;
    saveTokens(data);
    return token;
  },

  /** Deletes a token's record, redeemed or not. Access is computed from the token list (see platform.ts
   * paidAccessEnd), so the time a redeemed token granted stops counting as soon as it is deleted. */
  deleteToken(code: string): void {
    const data = loadTokens();
    const token = data.tokens.find((t) => t.code === code);
    if (!token) throw new TokenError('Token introuvable.', 404);
    data.tokens = data.tokens.filter((t) => t.code !== code);
    saveTokens(data);
  },

  /** A holder's paid access in an application: its redeemed, non-revoked tokens chained in redemption order
   * (each starts when the previous one ends, or when redeemed if access had lapsed). Kaly Manager computes
   * its own (trial, protected établissements — see platform.ts); this is for the other applications. */
  holderAccess(appId: string, holderId: string): { accessUntil: string | null; active: boolean; tokens: SubscriptionToken[] } {
    const tokens = loadTokens()
      .tokens.filter((t) => tokenAppId(t) === appId && t.usedAt && (t.usedBy ?? t.usedByEtablissementId) === holderId)
      .sort((a, b) => a.usedAt!.localeCompare(b.usedAt!));
    let end = 0;
    for (const t of tokens) {
      if (t.revoked) continue;
      const start = Math.max(end, new Date(t.usedAt!).getTime());
      end = start + this.daysFor(t) * 86_400_000;
    }
    return { accessUntil: end ? new Date(end).toISOString() : null, active: end > Date.now(), tokens };
  },

  /** Online purchase for another application: a token for the plan, redeemed for the holder straight away. */
  purchase(appId: string, planId: string, holderId: string, note: string): SubscriptionToken {
    const def = this.findPlan(planId, appId);
    if (!def || !def.active) throw new TokenError('Formule indisponible.');
    const [token] = this.generateTokens(def.id, 1, true, note, appId);
    return this.redeemToken(token.code, holderId, appId);
  },

  /** Cascade cleanup when a Kaly Manager établissement itself is deleted. */
  deleteTokensUsedBy(etablissementId: string): void {
    const data = loadTokens();
    const before = data.tokens.length;
    data.tokens = data.tokens.filter((t) => !(tokenAppId(t) === KALY_APP_ID && t.usedByEtablissementId === etablissementId));
    if (data.tokens.length !== before) saveTokens(data);
  },
};
