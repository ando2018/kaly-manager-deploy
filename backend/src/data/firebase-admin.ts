import fs from 'node:fs';
import path from 'node:path';
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

const DATA_ROOT = path.resolve(__dirname, '..', '..', 'data', 'etablissements');

interface ServiceAccountLike {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Each établissement brings its own Firebase project (its own service-account key), stored next to
 * its db.json. Two établissements pasting the *same* key just means they share one Firebase
 * project — safe, because each still gets its own Firestore document (keyed by établissement id),
 * exactly like two établissements on the LOCAL backend already get separate db.json files.
 */
const appCache = new Map<string, { app: App; firestore: Firestore }>();

function configPath(etablissementId: string): string {
  return path.join(DATA_ROOT, etablissementId, 'firebase-service-account.json');
}

function readStoredServiceAccount(etablissementId: string): ServiceAccountLike | undefined {
  const p = configPath(etablissementId);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ServiceAccountLike;
  } catch {
    return undefined;
  }
}

function toSdkServiceAccount(account: ServiceAccountLike) {
  return { projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key };
}

function ensureInitialized(etablissementId: string): { app: App; firestore: Firestore } | undefined {
  const cached = appCache.get(etablissementId);
  if (cached) return cached;

  const account = readStoredServiceAccount(etablissementId);
  if (!account) return undefined;

  // Named per établissement — even two orgs sharing identical credentials get distinct SDK app instances.
  const app = initializeApp({ credential: cert(toSdkServiceAccount(account)), projectId: account.project_id }, `etab-${etablissementId}`);
  const entry = { app, firestore: getFirestore(app) };
  appCache.set(etablissementId, entry);
  return entry;
}

export function isFirebaseConfigured(etablissementId: string): boolean {
  return ensureInitialized(etablissementId) !== undefined;
}

export function getFirebaseProjectId(etablissementId: string): string | undefined {
  return readStoredServiceAccount(etablissementId)?.project_id;
}

/** Returns this établissement's Firestore instance, or throws if it hasn't been configured yet. */
export function getFirestoreOrThrow(etablissementId: string): Firestore {
  const entry = ensureInitialized(etablissementId);
  if (!entry) throw new Error("Firebase Firestore n'est pas configuré pour cet établissement.");
  return entry.firestore;
}

async function evict(etablissementId: string): Promise<void> {
  const cached = appCache.get(etablissementId);
  if (!cached) return;
  appCache.delete(etablissementId);
  await deleteApp(cached.app).catch(() => undefined);
}

/** Parses, connection-tests, then persists a service-account JSON for one établissement — replacing any previous configuration for it. */
export async function setFirebaseServiceAccount(etablissementId: string, raw: string): Promise<{ projectId: string }> {
  let parsed: ServiceAccountLike;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JSON invalide.');
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Ce fichier ne ressemble pas à une clé de compte de service Firebase valide (project_id, client_email et private_key sont requis).",
    );
  }

  // Prove the credentials actually work before persisting them — a throwaway app, torn down right after.
  const probeApp = initializeApp(
    { credential: cert(toSdkServiceAccount(parsed)), projectId: parsed.project_id },
    `probe-${etablissementId}-${Date.now()}`,
  );
  try {
    await getFirestore(probeApp).listCollections();
  } catch {
    throw new Error('Connexion à Firestore impossible avec ces identifiants. Vérifiez la clé et les droits du compte de service.');
  } finally {
    await deleteApp(probeApp).catch(() => undefined);
  }

  const p = configPath(etablissementId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(parsed, null, 2), 'utf-8');

  await evict(etablissementId); // next access picks up the new credentials

  return { projectId: parsed.project_id };
}

export async function clearFirebaseServiceAccount(etablissementId: string): Promise<void> {
  const p = configPath(etablissementId);
  if (fs.existsSync(p)) fs.rmSync(p);
  await evict(etablissementId);
}
