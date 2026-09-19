import fs from 'node:fs';
import path from 'node:path';
import { cert, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

const CREDENTIAL_PATH = path.resolve(__dirname, '..', '..', 'data', 'platform-firebase-service-account.json');
const APP_NAME = 'platform-admin';

interface ServiceAccountLike {
  project_id: string;
  client_email: string;
  private_key: string;
}

let firestore: Firestore | undefined;

/**
 * The platform layer (établissements list, subscription tokens/pricing, contact messages) lives in
 * its own dedicated Firebase project — deliberately separate from any établissement's own Firestore
 * (configured per-org via the admin UI), so platform-wide data never shares a project with a
 * restaurant's operational data. This credential can't be set through the admin UI itself (the UI's
 * own data lives here), so it's a boot-time file the operator places by hand, same spirit as
 * JWT_SECRET/PLATFORM_ADMIN_KEY in .env.
 */
export function getPlatformFirestore(): Firestore {
  if (firestore) return firestore;

  if (!fs.existsSync(CREDENTIAL_PATH)) {
    throw new Error(
      `Firebase de la plateforme non configuré. Déposez la clé de compte de service JSON du projet ` +
        `Firebase dédié à l'administration (organisations + abonnements) dans :\n${CREDENTIAL_PATH}`,
    );
  }

  let account: ServiceAccountLike;
  try {
    account = JSON.parse(fs.readFileSync(CREDENTIAL_PATH, 'utf-8'));
  } catch {
    throw new Error(`Le fichier ${CREDENTIAL_PATH} ne contient pas un JSON valide.`);
  }
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error(
      `${CREDENTIAL_PATH} ne ressemble pas à une clé de compte de service Firebase valide ` +
        `(project_id, client_email et private_key sont requis).`,
    );
  }

  const app = initializeApp(
    {
      credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
      projectId: account.project_id,
    },
    APP_NAME,
  );
  firestore = getFirestore(app);
  return firestore;
}
