import { AnyBulkWriteOperation, Collection, Db, Document } from 'mongodb';
import { config } from '../config';
import { PLATFORM_COLLECTION, getMongoClient, readDoc } from './mongo';

/**
 * The token-manager's own MongoDB database (MONGODB_TOKENS_DB, default « token_manager »), on the same
 * MongoDB server as the app:
 *  - `apps`   { _id: appId, name, prefix, apiKey, createdAt }
 *  - `plans`  { _id: '<appId>:<planId>', appId, position, id, label, amount, unit, days, price, … }
 *  - `tokens` { _id: code, code, appId, plan, days, planLabel, createdAt, paid, note, usedAt, usedBy, revoked… }
 * Everything is also kept in memory (subscriptions.ts reads synchronously); each change is written as
 * per-document upserts/deletes of just what changed.
 */
export const TOKEN_COLLECTIONS = { apps: 'apps', plans: 'plans', tokens: 'tokens' } as const;

/** Documents keyed by a string _id (app id, « appId:planId », token code). */
export type StringIdDoc = Document & { _id: string };

/** Mirrors an in-memory list into a collection: `sync()` writes only the added/changed/removed items. */
export class MirroredCollection<T> {
  /** Last written JSON of each document, by _id. */
  private readonly saved = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly collection: Collection<StringIdDoc>,
    private readonly toDoc: (item: T) => StringIdDoc,
  ) {}

  /** Records what was just loaded from MongoDB (nothing to write for it). */
  markLoaded(items: T[]): void {
    for (const item of items) {
      const doc = clean(this.toDoc(item));
      this.saved.set(doc._id as string, JSON.stringify(doc));
    }
  }

  sync(items: T[]): Promise<void> {
    const ops: AnyBulkWriteOperation<StringIdDoc>[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const doc = clean(this.toDoc(item));
      const id = doc._id as string;
      seen.add(id);
      const json = JSON.stringify(doc);
      if (this.saved.get(id) === json) continue;
      this.saved.set(id, json);
      ops.push({ replaceOne: { filter: { _id: id }, replacement: doc, upsert: true } });
    }
    for (const id of [...this.saved.keys()]) {
      if (seen.has(id)) continue;
      this.saved.delete(id);
      ops.push({ deleteOne: { filter: { _id: id } } });
    }
    if (!ops.length) return this.queue;
    this.queue = this.queue.then(async () => {
      try {
        await this.collection.bulkWrite(ops, { ordered: true });
      } catch (err) {
        console.error(`Échec de l'écriture MongoDB (${config.mongo.tokensDbName}.${this.collection.collectionName}) :`, err);
      }
    });
    return this.queue;
  }
}

/** JSON semantics: drops undefined fields. */
function clean<D>(doc: D): D {
  return JSON.parse(JSON.stringify(doc)) as D;
}

export function tokensDb(): Db {
  return getMongoClient().db(config.mongo.tokensDbName);
}

/** Creates the collections and their indexes if missing. */
export async function ensureTokenCollections(): Promise<void> {
  const db = tokensDb();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of Object.values(TOKEN_COLLECTIONS)) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      console.log(`MongoDB : collection « ${config.mongo.tokensDbName}.${name} » créée.`);
    }
  }
  await db.collection(TOKEN_COLLECTIONS.plans).createIndex({ appId: 1, position: 1 });
  await db.collection(TOKEN_COLLECTIONS.tokens).createIndex({ appId: 1, createdAt: -1 });
  await db.collection(TOKEN_COLLECTIONS.tokens).createIndex({ usedBy: 1 }, { sparse: true });
}

/** The pre-« token_manager » documents, in the app's own database (copied over once). */
export async function readLegacyTokenDocs<P, T>(): Promise<{ pricing?: P; tokens?: T }> {
  return {
    pricing: await readDoc<P>(PLATFORM_COLLECTION, 'subscription-pricing'),
    tokens: await readDoc<T>(PLATFORM_COLLECTION, 'subscription-tokens'),
  };
}
