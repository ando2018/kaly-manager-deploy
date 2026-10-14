/**
 * One-time migration: copies everything from the former storages (the platform's Firestore, each
 * établissement's Firestore or local db.json) into MongoDB — the only storage the app uses now.
 *
 *   pm2 stop kaly-manager            # nothing must write meanwhile
 *   npm run migrate:mongo            # (--force: overwrite what is already in MongoDB)
 *   pm2 start kaly-manager
 *
 * Reads only: the Firestore documents and local files are left untouched (a backup until you delete them).
 * Run it once; afterwards this script, the firebase-admin package and backend/data/ are no longer needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { config } from '../config';
import { ETABLISSEMENTS_COLLECTION, PLATFORM_COLLECTION, closeMongo, connectMongo, readDoc, writeDoc } from '../data/mongo';

const DATA_ROOT = path.resolve(__dirname, '..', '..', 'data');
const PLATFORM_KEY = path.join(DATA_ROOT, 'platform-firebase-service-account.json');
const PLATFORM_DOCS = ['establishments', 'subscription-pricing', 'subscription-tokens', 'contact-messages'];
const force = process.argv.includes('--force');

interface LegacyMeta {
  id: string;
  name: string;
  storageBackend?: 'LOCAL' | 'FIRESTORE' | 'MONGODB';
  [key: string]: unknown;
}

const apps: App[] = [];

function firestoreFromKey(keyPath: string, name: string): Firestore {
  const account = JSON.parse(fs.readFileSync(keyPath, 'utf-8')) as { project_id: string; client_email: string; private_key: string };
  const app = initializeApp(
    { credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }), projectId: account.project_id },
    name,
  );
  apps.push(app);
  return getFirestore(app);
}

async function main(): Promise<void> {
  console.log(`Migration vers MongoDB — base « ${config.mongo.dbName} »${force ? ' (--force : écrase l’existant)' : ''}\n`);
  await connectMongo();
  let failures = 0;

  // ---- 1. Platform: établissements list, plans & tokens (every application), messages ----
  console.log('Plateforme :');
  const platformFs = fs.existsSync(PLATFORM_KEY) ? firestoreFromKey(PLATFORM_KEY, 'migrate-platform') : undefined;
  if (!platformFs) console.log(`  ⚠️ Clé Firebase de la plateforme absente (${PLATFORM_KEY}) : rien à copier depuis Firestore.`);
  for (const docId of PLATFORM_DOCS) {
    const existing = await readDoc(PLATFORM_COLLECTION, docId);
    if (existing !== undefined && !force) {
      console.log(`  = ${docId} : déjà dans MongoDB (ignoré)`);
      continue;
    }
    if (!platformFs) continue;
    try {
      const snap = await platformFs.collection('platform-admin').doc(docId).get();
      if (!snap.exists) {
        console.log(`  - ${docId} : absent de Firestore`);
        continue;
      }
      await writeDoc(PLATFORM_COLLECTION, docId, snap.data());
      console.log(`  ✓ ${docId} copié`);
    } catch (err) {
      failures++;
      console.log(`  ✗ ${docId} : ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---- 2. Each établissement's data ----
  const registry = await readDoc<{ etablissements: LegacyMeta[] }>(PLATFORM_COLLECTION, 'establishments');
  const list = registry?.etablissements ?? [];
  console.log(`\nÉtablissements (${list.length}) :`);
  for (const meta of list) {
    const label = `${meta.name} (${meta.id})`;
    try {
      if (!force && (await readDoc(ETABLISSEMENTS_COLLECTION, meta.id)) !== undefined) {
        console.log(`  = ${label} : déjà dans MongoDB (ignoré)`);
        continue;
      }
      const dir = path.join(DATA_ROOT, 'etablissements', meta.id);
      let data: unknown;
      let source: string;
      if (meta.storageBackend === 'FIRESTORE') {
        const key = path.join(dir, 'firebase-service-account.json');
        if (!fs.existsSync(key)) throw new Error(`clé Firebase absente (${key})`);
        const snap = await firestoreFromKey(key, `migrate-${meta.id}`).collection('etablissements').doc(meta.id).get();
        if (!snap.exists) throw new Error('document Firestore introuvable');
        data = snap.data();
        source = 'Firestore';
      } else {
        const file = path.join(dir, 'db.json');
        if (!fs.existsSync(file)) {
          console.log(`  - ${label} : aucune donnée locale (sera créé vide au premier accès)`);
          continue;
        }
        data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        source = 'fichier local';
      }
      await writeDoc(ETABLISSEMENTS_COLLECTION, meta.id, data);
      const d = data as { menu?: unknown[]; orders?: unknown[]; users?: unknown[] };
      console.log(`  ✓ ${label} ← ${source} : ${d.users?.length ?? 0} compte(s), ${d.menu?.length ?? 0} article(s), ${d.orders?.length ?? 0} commande(s)`);
    } catch (err) {
      failures++;
      console.log(`  ✗ ${label} : ${err instanceof Error ? err.message : err}`);
    }
  }

  // The storage choice no longer exists: drop the field from the établissements list.
  if (registry && list.some((m) => 'storageBackend' in m)) {
    for (const meta of list) delete meta.storageBackend;
    await writeDoc(PLATFORM_COLLECTION, 'establishments', registry);
  }

  console.log(failures ? `\n⚠️ Terminé avec ${failures} échec(s) — corrigez puis relancez (ce qui est déjà copié est ignoré).` : '\n✅ Migration terminée.');
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((err) => {
    console.error('\nÉchec de la migration :', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(apps.map((a) => deleteApp(a).catch(() => undefined)));
    await closeMongo();
  });
