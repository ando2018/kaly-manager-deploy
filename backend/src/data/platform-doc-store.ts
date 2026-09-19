import { getPlatformFirestore } from './platform-firebase';

const COLLECTION = 'platform-admin';

/**
 * Whole-document Firestore store — same "cache the whole blob in memory, sync reads, async
 * debounced write-through" model as FirestoreDatabase, so the platform.ts/subscriptions.ts/
 * contact-messages.ts call sites (all synchronous today) don't need to become async. Only the
 * one-time `create()` at server boot is awaited.
 */
export class PlatformDocStore<T> {
  private state: T;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly docId: string,
    private readonly docRef: FirebaseFirestore.DocumentReference,
    initialState: T,
  ) {
    this.state = initialState;
  }

  /**
   * Loads the doc if it exists; otherwise seeds it with `seedFn()` (which the caller uses to
   * migrate any pre-existing local JSON file's content on the very first boot after switching to
   * Firestore, instead of starting empty).
   */
  static async create<T>(docId: string, seedFn: () => T): Promise<PlatformDocStore<T>> {
    const ref = getPlatformFirestore().collection(COLLECTION).doc(docId);
    const snap = await ref.get();
    if (snap.exists) {
      return new PlatformDocStore(docId, ref, snap.data() as T);
    }
    const seed = seedFn();
    await ref.set(sanitize(seed) as FirebaseFirestore.DocumentData);
    return new PlatformDocStore(docId, ref, seed);
  }

  get data(): T {
    return this.state;
  }

  /** For callers that mutate the object returned by `data` in place and then need the write queued. */
  touch(): void {
    this.persist();
  }

  mutate<R>(fn: (state: T) => R): R {
    const result = fn(this.state);
    this.persist();
    return result;
  }

  private persist(): void {
    const snapshot = sanitize(this.state);
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.docRef.set(snapshot as FirebaseFirestore.DocumentData);
      } catch (err) {
        console.error(`Échec de l'écriture Firestore (plateforme/${this.docId}):`, err);
      }
    });
  }
}

/** Firestore rejects `undefined` field values — this drops them exactly like JSON.stringify did for the local file backend, keeping semantics identical. */
function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
