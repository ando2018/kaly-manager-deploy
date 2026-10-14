import { Collection, Db, MongoClient } from 'mongodb';
import { config } from '../config';

/**
 * MongoDB — where everything is stored (MONGODB_URI in backend/.env):
 *  - `platform`: the platform documents (établissements list, subscription plans & tokens, contact
 *    messages), one document each: { _id: '<doc id>', data, updatedAt };
 *  - `etablissements`: one document per établissement holding its whole data (menu, orders, team,
 *    events…): { _id: '<établissement id>', data, updatedAt }.
 * « Whole document in memory, written through »,
 * so the services don't know which storage they use. A MongoDB document holds up to 16 MB.
 */
export const PLATFORM_COLLECTION = 'platform';
export const ETABLISSEMENTS_COLLECTION = 'etablissements';

export interface StoredDoc<T> {
  _id: string;
  data: T;
  updatedAt: Date;
}

let client: MongoClient | undefined;
let db: Db | undefined;

export function isMongoConfigured(): boolean {
  return !!config.mongo.uri;
}

/** Connects once (at server start), and creates the collections if they don't exist yet. */
export async function connectMongo(): Promise<Db> {
  if (db) return db;
  if (!config.mongo.uri) {
    throw new Error(
      'MongoDB non configuré : ajoutez MONGODB_URI dans backend/.env, par exemple\n' +
        'MONGODB_URI=mongodb://kaly:MOT_DE_PASSE@127.0.0.1:27017/kaly_manager?authSource=kaly_manager',
    );
  }
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
  } catch (err) {
    client = undefined;
    throw new Error(`Connexion MongoDB impossible (${redact(config.mongo.uri)}) : ${err instanceof Error ? err.message : err}`);
  }
  db = client.db(config.mongo.dbName);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of [PLATFORM_COLLECTION, ETABLISSEMENTS_COLLECTION]) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      console.log(`MongoDB : collection « ${name} » créée.`);
    }
  }
  console.log(`MongoDB connecté — base « ${config.mongo.dbName} » (${redact(config.mongo.uri)}).`);
  return db;
}

export function getMongoClient(): MongoClient {
  if (!client) throw new Error("MongoDB n'est pas connecté.");
  return client;
}

export function getMongoDb(): Db {
  if (!db) throw new Error("MongoDB n'est pas connecté.");
  return db;
}

export function mongoCollection<T>(name: string): Collection<StoredDoc<T>> {
  return getMongoDb().collection<StoredDoc<T>>(name);
}

/** Reads one stored document's data, or undefined. */
export async function readDoc<T>(collection: string, id: string): Promise<T | undefined> {
  const doc = await mongoCollection<T>(collection).findOne({ _id: id });
  return doc?.data;
}

/** Replaces (or creates) one stored document. */
export async function writeDoc<T>(collection: string, id: string, data: T): Promise<void> {
  await mongoCollection<T>(collection).replaceOne({ _id: id }, { data: sanitize(data), updatedAt: new Date() }, { upsert: true });
}

export async function deleteDoc(collection: string, id: string): Promise<void> {
  await mongoCollection(collection).deleteOne({ _id: id });
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}

/** Drops `undefined` fields and Date/class instances (JSON semantics). */
export function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The URI without its password, for logs. */
function redact(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');
}
