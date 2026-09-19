import fs from 'node:fs';
import path from 'node:path';
import { platform } from './platform';
import { primeEtablissementContext } from './etablissement-registry';

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'db.json');
const LEGACY_DB_MIGRATED_MARKER = path.join(DATA_DIR, 'db.json.migrated');
const LEGACY_UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
const ETABLISSEMENTS_DIR = path.join(DATA_DIR, 'etablissements');
const MIGRATION_NOTE_PATH = path.join(DATA_DIR, 'ETABLISSEMENT_ID.txt');

/**
 * One-time migration: the app used to run as a single établissement with a flat
 * `data/db.json` and a flat `uploads/` folder. On first boot after the
 * multi-établissement upgrade, adopt that data as the first registered établissement
 * instead of discarding it.
 */
export function migrateLegacyDataIfNeeded(): void {
  if (!fs.existsSync(LEGACY_DB_PATH)) return; // nothing to migrate (fresh install, or already migrated)

  const meta = platform.createEtablissement('Mon Établissement', 'Administrateur');
  const targetDir = path.join(ETABLISSEMENTS_DIR, meta.id);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(LEGACY_DB_PATH, path.join(targetDir, 'db.json'));
  fs.writeFileSync(LEGACY_DB_MIGRATED_MARKER, `Migré vers l'établissement ${meta.id} le ${new Date().toISOString()}\n`);

  if (fs.existsSync(LEGACY_UPLOADS_DIR)) {
    const entries = fs.readdirSync(LEGACY_UPLOADS_DIR, { withFileTypes: true });
    const targetUploadsDir = path.join(LEGACY_UPLOADS_DIR, meta.id);
    const looseFiles = entries.filter((e) => e.isFile() && e.name !== '.gitkeep');
    if (looseFiles.length > 0) {
      fs.mkdirSync(targetUploadsDir, { recursive: true });
      for (const entry of looseFiles) {
        fs.renameSync(path.join(LEGACY_UPLOADS_DIR, entry.name), path.join(targetUploadsDir, entry.name));
      }
    }
  }

  // Warm the registry cache so the freshly-moved data is used immediately, not re-seeded.
  primeEtablissementContext(meta.id);

  fs.writeFileSync(
    MIGRATION_NOTE_PATH,
    `Vos données existantes ont été conservées sous l'identifiant établissement : ${meta.id}\n` +
      `Utilisez cet identifiant sur l'écran de connexion pour retrouver votre équipe, votre carte et vos commandes.\n`,
  );

  // eslint-disable-next-line no-console
  console.log('\n' + '='.repeat(64));
  console.log('  MIGRATION DES DONNÉES EXISTANTES TERMINÉE');
  console.log(`  Identifiant de votre établissement : ${meta.id}`);
  console.log('  (également noté dans backend/data/ETABLISSEMENT_ID.txt)');
  console.log('='.repeat(64) + '\n');
}
