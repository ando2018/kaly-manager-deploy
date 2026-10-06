import fs from 'node:fs';
import path from 'node:path';
import { PlatformDocStore } from './platform-doc-store';
import { SubscriptionPlan, TRIAL_DAYS, subscriptions } from './subscriptions';

export type StorageBackend = 'LOCAL' | 'FIRESTORE';

export interface SubscriptionEvent {
  at: string;
  source: 'TOKEN' | 'ADMIN';
  action?: 'EXTEND' | 'SUSPEND' | 'UNSUSPEND';
  plan?: SubscriptionPlan;
  days: number;
  tokenCode?: string;
  /** Snapshot of what was bought (absent on older events). */
  planLabel?: string;
  durationLabel?: string;
  price?: number;
  /** Bought online from the app (vs. a token typed in, or granted by the platform). */
  purchase?: boolean;
  /** Access end right after this extension — the added time stacks on whatever was left. */
  accessUntil?: string;
}

export interface SubscriptionState {
  /** Free-access cutoff, set once at creation — never moves after that. */
  trialEndsAt: string;
  /** Paid-access cutoff, absent until the first token redemption or admin grant. */
  expiresAt?: string;
  /** Admin kill switch — overrides trial/paid time entirely while true. Cleared automatically the next time a token is redeemed or the admin grants more time. */
  suspended?: boolean;
  suspendedAt?: string;
  history: SubscriptionEvent[];
}

export interface SubscriptionStatus {
  active: boolean;
  inTrial: boolean;
  suspended: boolean;
  trialEndsAt: string;
  expiresAt: string | null;
  accessUntil: string;
  daysLeft: number;
  archived: boolean;
  /** An e-mail is on file for the Direction (where a purchased token is sent) — the address itself stays private. */
  hasAdminEmail: boolean;
  /** Had a subscription before, now expired / suspended / archived: everything can still be consulted
   * (stock, suivi, caisse, statistiques) but nothing new can be recorded until a new subscription. */
  readOnly: boolean;
}

export interface EtablissementMeta {
  id: string;
  name: string;
  adminName?: string;
  /** Where the platform writes to this établissement's admin (e.g. the user guide). */
  adminEmail?: string;
  createdAt: string;
  archived?: boolean;
  archivedAt?: string;
  lastActivityAt?: string;
  /** Standing test sandbox — exempt from the one-by-one delete action on the platform admin screen. */
  protected?: boolean;
  /** Defaults to LOCAL (db.json on disk) when absent. */
  storageBackend?: StorageBackend;
  subscription?: SubscriptionState;
}

interface PlatformShape {
  etablissements: EtablissementMeta[];
}

const PLATFORM_PATH = path.resolve(__dirname, '..', '..', 'data', 'platform.json');
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I — avoids ambiguity when typed by hand

let store: PlatformDocStore<PlatformShape> | undefined;

/**
 * Loads établissements from the platform's dedicated Firestore project, migrating any pre-existing
 * local platform.json into it on the very first boot after switching. Must resolve before any other
 * export in this module is called — server.ts awaits it before starting to listen.
 */
export async function initPlatformStore(): Promise<void> {
  store = await PlatformDocStore.create<PlatformShape>('establishments', () => {
    if (!fs.existsSync(PLATFORM_PATH)) return { etablissements: [] };
    const raw = JSON.parse(fs.readFileSync(PLATFORM_PATH, 'utf-8')) as PlatformShape & { restaurants?: EtablissementMeta[] };
    return raw.etablissements ? raw : { etablissements: raw.restaurants ?? [] };
  });
  if (fs.existsSync(PLATFORM_PATH)) {
    fs.renameSync(PLATFORM_PATH, `${PLATFORM_PATH}.migrated`);
  }
}

function load(): PlatformShape {
  if (!store) throw new Error('Platform store not initialized — call initPlatformStore() at server boot.');
  return store.data;
}

function save(_data: PlatformShape): void {
  store!.touch();
}

function randomGroup(length: number): string {
  return Array.from({ length }, () => ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]).join('');
}

/** Format: "4BR7-XYWE-FF32-PPZ1" — four 4-character groups, easier to read/type aloud than one long block. */
function generateEtablissementId(existing: Set<string>): string {
  let id: string;
  do {
    id = Array.from({ length: 4 }, () => randomGroup(4)).join('-');
  } while (existing.has(id));
  return id;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function freshSubscription(createdAt: string): SubscriptionState {
  return { trialEndsAt: addDays(new Date(createdAt), TRIAL_DAYS).toISOString(), history: [] };
}

/** No more free trial — a brand-new établissement is blocked immediately and needs a real token (or an
 * admin grant) before it can be used. `trialEndsAt` is set to `createdAt` itself so every other piece of
 * subscription logic (inTrial/active/daysLeft) keeps working unchanged, just with a zero-length window. */
function blockedSubscription(createdAt: string): SubscriptionState {
  return { trialEndsAt: createdAt, history: [] };
}

/** Établissements registered before the subscription system existed have no `subscription` field — grant them a trial computed from their original creation date, same as any new one. */
function ensureSubscription(meta: EtablissementMeta): SubscriptionState {
  if (!meta.subscription) meta.subscription = freshSubscription(meta.createdAt);
  return meta.subscription;
}

/** Ever had real access (a redeemed token or an admin grant) — as opposed to a never-activated établissement. */
function everSubscribed(sub: SubscriptionState): boolean {
  return !!sub.expiresAt || sub.history.some((h) => h.action === undefined || h.action === 'EXTEND');
}

/** One block of paid access for an établissement, in activation order — shown in /ap. */
export interface AccessPeriod {
  kind: 'TOKEN' | 'ADMIN';
  tokenCode?: string;
  planLabel?: string;
  days: number;
  price?: number;
  purchase?: boolean;
  activatedAt: string;
  /** Null for a token that no longer counts (revoked, or deleted from the list). */
  start: string | null;
  end: string | null;
  status: 'COUNTED' | 'REVOKED' | 'DELETED';
}

/**
 * Paid access is worked out from the token list, not from a stored date: every token this établissement
 * redeemed that is still in the list and not revoked counts, one after the other (each starts when it was
 * redeemed, or when the previous one ends if that's later). A token deleted or revoked in /ap therefore
 * stops counting at once. Access only ever comes from tokens (bought or typed in) — no platform grants.
 * Returns null when the token store can't be read yet (boot).
 */
/** A plan id as a label (« Mois » rather than MONTH) — old history entries only stored the id. */
function labelOf(plan: SubscriptionPlan | undefined): string | undefined {
  if (!plan) return undefined;
  return subscriptions.findPlan(plan)?.label ?? ({ DAY: '1 jour', TWO_DAYS: '2 jours', WEEK: 'Semaine', MONTH: 'Mois', YEAR: 'An' } as Record<string, string>)[plan] ?? plan;
}

function accessPeriodsFor(meta: EtablissementMeta, sub: SubscriptionState): AccessPeriod[] | null {
  let tokens: ReturnType<typeof subscriptions.listTokens>;
  try {
    tokens = subscriptions.listTokens().filter((t) => t.usedByEtablissementId === meta.id && t.usedAt);
  } catch {
    return null;
  }
  const byCode = new Map(tokens.map((t) => [t.code, t]));
  const periods: AccessPeriod[] = [];
  for (const t of tokens) {
    const event = sub.history.find((h) => h.tokenCode === t.code);
    periods.push({
      kind: 'TOKEN',
      tokenCode: t.code,
      planLabel: t.planLabel ?? event?.planLabel ?? subscriptions.findPlan(t.plan)?.label ?? t.plan,
      days: subscriptions.daysFor(t),
      price: event?.price,
      purchase: event?.purchase,
      activatedAt: t.usedAt!,
      start: null,
      end: null,
      status: t.revoked ? 'REVOKED' : 'COUNTED',
    });
  }
  for (const h of sub.history) {
    if ((h.action ?? 'EXTEND') !== 'EXTEND') continue;
    if (h.tokenCode && !byCode.has(h.tokenCode)) {
      // Redeemed once, since deleted from the token list: listed for the record, no longer counted.
      periods.push({
        kind: 'TOKEN',
        tokenCode: h.tokenCode,
        planLabel: h.planLabel ?? labelOf(h.plan),
        days: h.days,
        price: h.price,
        purchase: h.purchase,
        activatedAt: h.at,
        start: null,
        end: null,
        status: 'DELETED',
      });
    }
  }
  periods.sort((a, b) => new Date(a.activatedAt).getTime() - new Date(b.activatedAt).getTime());
  let chainEnd = -Infinity;
  for (const p of periods) {
    if (p.status !== 'COUNTED') continue;
    const startMs = Math.max(new Date(p.activatedAt).getTime(), chainEnd);
    chainEnd = startMs + p.days * 24 * 60 * 60 * 1000;
    p.start = new Date(startMs).toISOString();
    p.end = new Date(chainEnd).toISOString();
  }
  return periods;
}

/** End of paid access in ms (null when nothing counts) — the end of the last counted period. */
function paidAccessEnd(meta: EtablissementMeta, sub: SubscriptionState): number | null {
  const periods = accessPeriodsFor(meta, sub);
  if (!periods) return sub.expiresAt ? new Date(sub.expiresAt).getTime() : null;
  const ends = periods.filter((p) => p.end).map((p) => new Date(p.end!).getTime());
  return ends.length ? Math.max(...ends) : null;
}

function statusFor(meta: EtablissementMeta): SubscriptionStatus {
  const sub = ensureSubscription(meta);
  const trialMs = new Date(sub.trialEndsAt).getTime();
  const paidEnd = paidAccessEnd(meta, sub);
  const expiresMs = paidEnd ?? -Infinity;
  const now = Date.now();
  // A protected établissement (the test sandbox) is never gated behind a subscription.
  const accessUntilMs = meta.protected ? now + 100 * 365 * 24 * 60 * 60 * 1000 : Math.max(trialMs, expiresMs);
  const suspended = sub.suspended === true && !meta.protected;
  return {
    active: !suspended && now < accessUntilMs,
    inTrial: !suspended && now < trialMs,
    suspended,
    trialEndsAt: sub.trialEndsAt,
    expiresAt: paidEnd !== null ? new Date(paidEnd).toISOString() : null,
    accessUntil: new Date(accessUntilMs).toISOString(),
    daysLeft: suspended ? 0 : Math.max(0, Math.ceil((accessUntilMs - now) / (24 * 60 * 60 * 1000))),
    archived: meta.archived === true,
    hasAdminEmail: !!meta.adminEmail,
    readOnly: (meta.archived === true || suspended || now >= accessUntilMs) && everSubscribed(sub),
  };
}

export const platform = {
  listEtablissements(): EtablissementMeta[] {
    return load().etablissements;
  },

  findEtablissement(id: string): EtablissementMeta | undefined {
    const normalized = id.trim().toUpperCase();
    return load().etablissements.find((r) => r.id === normalized);
  },

  createEtablissement(name: string, adminName: string, adminEmail?: string): EtablissementMeta {
    const data = load();
    const id = generateEtablissementId(new Set(data.etablissements.map((r) => r.id)));
    const createdAt = new Date().toISOString();
    const meta: EtablissementMeta = {
      id,
      name: name.trim(),
      adminName: adminName.trim(),
      adminEmail: adminEmail?.trim() || undefined,
      createdAt,
      subscription: blockedSubscription(createdAt),
    };
    data.etablissements.push(meta);
    save(data);
    return meta;
  },

  /** Removes exactly one établissement's platform.json entry — caller is responsible for its data/uploads. */
  remove(id: string): void {
    const data = load();
    const normalized = id.trim().toUpperCase();
    data.etablissements = data.etablissements.filter((e) => e.id !== normalized);
    save(data);
  },

  setProtected(id: string, protectedFlag: boolean): EtablissementMeta {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    meta.protected = protectedFlag;
    save(data);
    return meta;
  },

  /** Registers an établissement under a caller-chosen id (used by the legacy-data migration only). */
  registerExisting(id: string, name: string): EtablissementMeta {
    const data = load();
    if (data.etablissements.some((r) => r.id === id)) {
      throw new Error(`Établissement id already registered: ${id}`);
    }
    const createdAt = new Date().toISOString();
    const meta: EtablissementMeta = { id, name, createdAt, subscription: freshSubscription(createdAt) };
    data.etablissements.push(meta);
    save(data);
    return meta;
  },

  setAdminEmail(id: string, adminEmail: string | undefined): EtablissementMeta {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    meta.adminEmail = adminEmail?.trim() || undefined;
    save(data);
    return meta;
  },

  setStorageBackend(id: string, backend: StorageBackend): EtablissementMeta {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    meta.storageBackend = backend;
    save(data);
    return meta;
  },

  setArchived(id: string, archived: boolean): EtablissementMeta {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    meta.archived = archived;
    meta.archivedAt = archived ? new Date().toISOString() : undefined;
    save(data);
    return meta;
  },

  /** Records activity (any API call) for an établissement. Throttled to avoid a disk write per request. */
  touchActivity(id: string): void {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) return;
    const now = Date.now();
    const last = meta.lastActivityAt ? new Date(meta.lastActivityAt).getTime() : 0;
    if (now - last < 60_000) return;
    meta.lastActivityAt = new Date(now).toISOString();
    save(data);
  },

  /** Access status only — cheap, used on every request by the resolveEtablissement gate. */
  subscriptionStatus(id: string): SubscriptionStatus | undefined {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) return undefined;
    const status = statusFor(meta);
    save(data); // persists a lazily-created `subscription` field, if this établissement pre-dates it
    return status;
  },

  /** Every token / grant of this établissement in activation order, with its start and end — /ap list. */
  accessPeriods(id: string): AccessPeriod[] {
    const meta = load().etablissements.find((r) => r.id === id.trim().toUpperCase());
    if (!meta) return [];
    return accessPeriodsFor(meta, ensureSubscription(meta)) ?? [];
  },

  /** Status + full redemption history — used by the platform admin subscription panel. */
  subscriptionDetail(id: string): (SubscriptionStatus & { history: SubscriptionEvent[] }) | undefined {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) return undefined;
    const status = statusFor(meta);
    save(data);
    return { ...status, history: ensureSubscription(meta).history };
  },

  /**
   * Extends paid access by `days`, stacking on top of whichever is later: the current access
   * cutoff (trial or already-paid time) or now. Redeeming/granting early never wastes remaining
   * time; redeeming after expiry starts counting from today.
   */
  extendSubscription(
    id: string,
    event: {
      source: 'TOKEN' | 'ADMIN';
      days: number;
      plan?: SubscriptionPlan;
      tokenCode?: string;
      planLabel?: string;
      durationLabel?: string;
      price?: number;
      purchase?: boolean;
    },
  ): SubscriptionStatus {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    const sub = ensureSubscription(meta);
    // A fresh token/grant is exactly how a suspended établissement is meant to get back in.
    sub.suspended = false;
    sub.suspendedAt = undefined;
    // …and an archived one too: a new subscription brings it back into service.
    meta.archived = false;
    meta.archivedAt = undefined;
    const entry: SubscriptionEvent = {
      at: new Date().toISOString(),
      source: event.source,
      action: 'EXTEND',
      plan: event.plan,
      days: event.days,
      tokenCode: event.tokenCode,
      planLabel: event.planLabel,
      durationLabel: event.durationLabel,
      price: event.price,
      purchase: event.purchase,
    };
    sub.history.push(entry);
    // The redeemed token (already marked used) or this grant is now part of the chain — recompute from it.
    const end = paidAccessEnd(meta, sub);
    sub.expiresAt = end !== null ? new Date(end).toISOString() : undefined;
    entry.accessUntil = sub.expiresAt;
    save(data);
    return statusFor(meta);
  },

  /**
   * Admin kill switch — cuts off access immediately regardless of remaining trial/paid time, and
   * (once the platform-admin UI's gate re-checks) puts the établissement on the same "insert a
   * token to get back in" screen as a naturally expired subscription. Redeeming a token or an
   * admin grant clears it automatically; `setSuspended(id, false)` also lifts it without either.
   */
  setSuspended(id: string, suspended: boolean): SubscriptionStatus {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    const sub = ensureSubscription(meta);
    sub.suspended = suspended;
    sub.suspendedAt = suspended ? new Date().toISOString() : undefined;
    sub.history.push({
      at: new Date().toISOString(),
      source: 'ADMIN',
      action: suspended ? 'SUSPEND' : 'UNSUSPEND',
      days: 0,
    });
    save(data);
    return statusFor(meta);
  },
};
