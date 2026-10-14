import { DbShape } from '../models/types';
import { IEtablissementDatabase, migrate } from './db';
import { ETABLISSEMENTS_COLLECTION, readDoc, writeDoc } from './mongo';

/**
 * An établissement's data in MongoDB — one document per établissement
 * (collection `etablissements`, _id = établissement id) holds the whole `DbShape`, kept in memory and
 * written through after each change.
 */
export class MongoDatabase implements IEtablissementDatabase {
  private state: DbShape;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly etablissementId: string,
    initialState: DbShape,
  ) {
    this.state = initialState;
  }

  static async create(etablissementId: string, seedFn: () => DbShape): Promise<MongoDatabase> {
    const stored = await readDoc<DbShape>(ETABLISSEMENTS_COLLECTION, etablissementId);
    if (stored) {
      // Same backfill the other backends apply on load — a stored document can predate a field.
      if (migrate(stored)) await writeDoc(ETABLISSEMENTS_COLLECTION, etablissementId, stored);
      return new MongoDatabase(etablissementId, stored);
    }
    const seed = seedFn();
    await writeDoc(ETABLISSEMENTS_COLLECTION, etablissementId, seed);
    return new MongoDatabase(etablissementId, seed);
  }

  /** Copies an établissement's current data into MongoDB (switching it from LOCAL/FIRESTORE). */
  static async importData(etablissementId: string, data: DbShape): Promise<void> {
    await writeDoc(ETABLISSEMENTS_COLLECTION, etablissementId, data);
  }

  get data(): DbShape {
    return this.state;
  }

  mutate<T>(fn: (state: DbShape) => T): T {
    const result = fn(this.state);
    this.persist();
    return result;
  }

  /** Resolves once every queued write has reached MongoDB. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = this.state;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeDoc(ETABLISSEMENTS_COLLECTION, this.etablissementId, snapshot);
      } catch (err) {
        console.error(`Échec de l'écriture MongoDB pour l'établissement ${this.etablissementId}:`, err);
      }
    });
  }
}
