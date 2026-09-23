import fs from 'node:fs';
import path from 'node:path';
import { PlatformDocStore } from './platform-doc-store';
import { SubscriptionPlan, TRIAL_DAYS } from './subscriptions';

export type StorageBackend = 'LOCAL' | 'FIRESTORE';

export interface SubscriptionEvent {
  at: string;
  source: 'TOKEN' | 'ADMIN';
  action?: 'EXTEND' | 'SUSPEND' | 'UNSUSPEND';
  plan?: SubscriptionPlan;
  days: number;
  tokenCode?: string;
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
}

export interface EtablissementMeta {
  id: string;
  name: string;
  adminName?: string;
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

function statusFor(meta: EtablissementMeta): SubscriptionStatus {
  const sub = ensureSubscription(meta);
  const trialMs = new Date(sub.trialEndsAt).getTime();
  const expiresMs = sub.expiresAt ? new Date(sub.expiresAt).getTime() : -Infinity;
  const accessUntilMs = Math.max(trialMs, expiresMs);
  const now = Date.now();
  const suspended = sub.suspended === true;
  return {
    active: !suspended && now < accessUntilMs,
    inTrial: !suspended && now < trialMs,
    suspended,
    trialEndsAt: sub.trialEndsAt,
    expiresAt: sub.expiresAt ?? null,
    accessUntil: new Date(accessUntilMs).toISOString(),
    daysLeft: suspended ? 0 : Math.max(0, Math.ceil((accessUntilMs - now) / (24 * 60 * 60 * 1000))),
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

  createEtablissement(name: string, adminName: string): EtablissementMeta {
    const data = load();
    const id = generateEtablissementId(new Set(data.etablissements.map((r) => r.id)));
    const createdAt = new Date().toISOString();
    const meta: EtablissementMeta = {
      id,
      name: name.trim(),
      adminName: adminName.trim(),
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
    event: { source: 'TOKEN' | 'ADMIN'; days: number; plan?: SubscriptionPlan; tokenCode?: string },
  ): SubscriptionStatus {
    const data = load();
    const normalized = id.trim().toUpperCase();
    const meta = data.etablissements.find((r) => r.id === normalized);
    if (!meta) {
      throw new Error(`Établissement not found: ${id}`);
    }
    const sub = ensureSubscription(meta);
    const currentAccessUntil = Math.max(new Date(sub.trialEndsAt).getTime(), sub.expiresAt ? new Date(sub.expiresAt).getTime() : -Infinity);
    const base = Math.max(Date.now(), currentAccessUntil);
    sub.expiresAt = addDays(new Date(base), event.days).toISOString();
    // A fresh token/grant is exactly how a suspended établissement is meant to get back in.
    sub.suspended = false;
    sub.suspendedAt = undefined;
    sub.history.push({
      at: new Date().toISOString(),
      source: event.source,
      action: 'EXTEND',
      plan: event.plan,
      days: event.days,
      tokenCode: event.tokenCode,
    });
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
