import { PLATFORM_COLLECTION, readDoc, writeDoc } from './mongo';

/**
 * Whole-document store for the platform data (établissements list, subscription plans & tokens,
 * contact messages), in MongoDB's `platform` collection — "cache the whole blob in memory, sync reads,
 * async write-through", so the platform.ts/subscriptions.ts/contact-messages.ts call sites (all
 * synchronous) don't need to become async. Only the one-time `create()` at server boot is awaited.
 */
export class PlatformDocStore<T> {
  private state: T;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly docId: string,
    initialState: T,
  ) {
    this.state = initialState;
  }

  /** Loads the doc if it exists; otherwise creates it with `seedFn()`. */
  static async create<T>(docId: string, seedFn: () => T): Promise<PlatformDocStore<T>> {
    const stored = await readDoc<T>(PLATFORM_COLLECTION, docId);
    if (stored !== undefined) return new PlatformDocStore<T>(docId, stored as T);
    const seed = seedFn();
    await writeDoc(PLATFORM_COLLECTION, docId, seed);
    return new PlatformDocStore<T>(docId, seed);
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
    const snapshot = JSON.parse(JSON.stringify(this.state)) as T;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeDoc(PLATFORM_COLLECTION, this.docId, snapshot);
      } catch (err) {
        console.error(`Échec de l'écriture MongoDB (plateforme/${this.docId}):`, err);
      }
    });
  }
}
