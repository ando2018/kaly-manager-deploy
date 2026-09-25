import { DbShape } from '../models/types';
import { IEtablissementDatabase, migrate } from './db';
import { getFirestoreOrThrow } from './firebase-admin';

const COLLECTION = 'etablissements';

/**
 * Firestore-backed counterpart to `JsonDatabase` — same whole-blob-in-memory model (one document
 * per établissement holds the entire `DbShape`), so every service works unmodified regardless of
 * which backend an établissement uses. Chosen over a collection-per-entity design to keep this a
 * drop-in swap; the tradeoff is Firestore's ~1 MiB per-document limit, plenty for a single
 * restaurant's live operational data but worth knowing if order history grows very large.
 */
export class FirestoreDatabase implements IEtablissementDatabase {
  private state: DbShape;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly docRef;

  private constructor(
    private readonly etablissementId: string,
    initialState: DbShape,
  ) {
    this.state = initialState;
    this.docRef = getFirestoreOrThrow(etablissementId).collection(COLLECTION).doc(etablissementId);
  }

  static async create(etablissementId: string, seedFn: () => DbShape): Promise<FirestoreDatabase> {
    const ref = getFirestoreOrThrow(etablissementId).collection(COLLECTION).doc(etablissementId);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as DbShape;
      // Same backfill JsonDatabase applies on load — Firestore documents can equally predate a field.
      if (migrate(data)) await ref.set(sanitize(data));
      return new FirestoreDatabase(etablissementId, data);
    }
    const seed = seedFn();
    await ref.set(sanitize(seed));
    return new FirestoreDatabase(etablissementId, seed);
  }

  get data(): DbShape {
    return this.state;
  }

  mutate<T>(fn: (state: DbShape) => T): T {
    const result = fn(this.state);
    this.persist();
    return result;
  }

  private persist(): void {
    const snapshot = sanitize(this.state);
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.docRef.set(snapshot);
      } catch (err) {
        console.error(`Échec de l'écriture Firestore pour l'établissement ${this.etablissementId}:`, err);
      }
    });
  }
}

/** Firestore rejects `undefined` field values, which our optional DbShape fields use freely — this drops them exactly like JSON.stringify does for the local file backend, keeping both backends' semantics identical. */
function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
