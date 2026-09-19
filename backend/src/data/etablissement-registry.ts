import path from 'node:path';
import { IEtablissementDatabase, JsonDatabase, buildDemoSeed, buildFreshSeed } from './db';
import { FirestoreDatabase } from './firestore-db';
import { platform } from './platform';
import { createMenuService } from '../services/menu.service';
import { createOrdersService } from '../services/orders.service';
import { createUsersService } from '../services/users.service';
import { createAuthService } from '../services/auth.service';
import { createEventsService } from '../services/events.service';

export interface EtablissementContext {
  id: string;
  db: IEtablissementDatabase;
  menu: ReturnType<typeof createMenuService>;
  orders: ReturnType<typeof createOrdersService>;
  users: ReturnType<typeof createUsersService>;
  auth: ReturnType<typeof createAuthService>;
  events: ReturnType<typeof createEventsService>;
}

const DATA_ROOT = path.resolve(__dirname, '..', '..', 'data', 'etablissements');
const cache = new Map<string, EtablissementContext>();
const pending = new Map<string, Promise<EtablissementContext>>();

function servicesFor(etablissementId: string, db: IEtablissementDatabase): EtablissementContext {
  const menu = createMenuService(db, etablissementId);
  return {
    id: etablissementId,
    db,
    menu,
    orders: createOrdersService(db, menu),
    users: createUsersService(db),
    auth: createAuthService(db, etablissementId),
    events: createEventsService(db),
  };
}

async function buildContext(etablissementId: string, adminName?: string): Promise<EtablissementContext> {
  const meta = platform.findEtablissement(etablissementId);
  const seedFn = etablissementId === 'DEMO' ? buildDemoSeed : () => buildFreshSeed(adminName);

  if (meta?.storageBackend === 'FIRESTORE') {
    const db = await FirestoreDatabase.create(etablissementId, seedFn);
    return servicesFor(etablissementId, db);
  }

  const dbPath = path.join(DATA_ROOT, etablissementId, 'db.json');
  const db = new JsonDatabase(dbPath, seedFn);
  return servicesFor(etablissementId, db);
}

/**
 * Synchronous, cache-only lookup — never builds. Safe for hot paths (socket broadcasts) that only
 * run once a request has already warmed the context via `ensureEtablissementContext`. Returns
 * undefined for a not-yet-warmed établissement even if it's registered.
 */
export function getEtablissementContext(etablissementId: string): EtablissementContext | undefined {
  return cache.get(etablissementId.trim().toUpperCase());
}

/**
 * Resolves (building/warming if necessary) a *registered* établissement's context, or undefined if
 * the id is unknown. Building is async because a Firestore-backed établissement needs a network
 * round-trip on cold start; a Local one resolves immediately. Concurrent calls for the same id
 * share one in-flight build instead of racing.
 */
export async function ensureEtablissementContext(etablissementId: string): Promise<EtablissementContext | undefined> {
  const normalized = etablissementId.trim().toUpperCase();
  const cached = cache.get(normalized);
  if (cached) return cached;

  const inFlight = pending.get(normalized);
  if (inFlight) return inFlight;

  const meta = platform.findEtablissement(normalized);
  if (!meta) return undefined;

  const buildPromise = buildContext(normalized, meta.adminName)
    .then((context) => {
      cache.set(normalized, context);
      return context;
    })
    .finally(() => {
      pending.delete(normalized);
    });
  pending.set(normalized, buildPromise);
  return buildPromise;
}

/** Used only by the legacy-data migration, which registers the id in platform.json itself beforehand. Always local. */
export function primeEtablissementContext(etablissementId: string): EtablissementContext {
  const normalized = etablissementId.trim().toUpperCase();
  const dbPath = path.join(DATA_ROOT, normalized, 'db.json');
  const db = new JsonDatabase(dbPath, () => buildFreshSeed());
  const context = servicesFor(normalized, db);
  cache.set(normalized, context);
  return context;
}

/** Drops a cached context (e.g. its data directory was just deleted, or its storage backend changed) so a later lookup starts fresh. */
export function evictEtablissementContext(etablissementId: string): void {
  cache.delete(etablissementId.trim().toUpperCase());
}
