import fs from 'node:fs';
import path from 'node:path';
import { IEtablissementDatabase } from '../data/db';
import { DbShape, EventStockEntry, MenuCategory, MenuItem, StockActionType, StockHistoryEntry } from '../models/types';
import { generateId } from '../utils/id';
import { UPLOADS_PUBLIC_PATH, etablissementUploadsDir } from '../middleware/upload.middleware';

export class MenuError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface CreateMenuItemInput {
  name: string;
  category: MenuCategory;
  price: number;
  stockQuantity: number;
  image?: string;
  description?: string;
  ingredients?: string[];
}

export interface UpdateMenuItemInput {
  name?: string;
  category?: MenuCategory;
  price?: number;
  image?: string;
  description?: string;
  ingredients?: string[];
}

/** Who performed a manual action — omitted for the automatic order-decrement entry. */
export interface StockActor {
  userId?: string;
  userName?: string;
}

const MANDATORY_COMMENT_ACTIONS: ReadonlySet<StockActionType> = new Set(['RESTOCK', 'ADJUST', 'SET', 'PRICE_CHANGE']);

export function createMenuService(db: IEtablissementDatabase, etablissementId: string) {
  /** Best-effort delete of a previously-uploaded image file; no-op for external URLs (seed images, etc.). */
  function deleteUploadedImageIfLocal(imageUrl: string | undefined): void {
    if (!imageUrl) return;
    const marker = `${UPLOADS_PUBLIC_PATH}/${etablissementId}/`;
    const idx = imageUrl.indexOf(marker);
    if (idx === -1) return;
    const filename = imageUrl.slice(idx + marker.length).split(/[?#]/)[0];
    if (!filename || filename.includes('/') || filename.includes('..')) return;
    fs.unlink(path.join(etablissementUploadsDir(etablissementId), filename), () => {
      // Ignore errors: file may already be gone, or shared/replaced — deletion is best-effort cleanup.
    });
  }

  /** Appends one history entry — throws first if the action requires a comment and none was given. */
  function recordHistory(
    state: DbShape,
    item: MenuItem,
    action: StockActionType,
    fields: Omit<StockHistoryEntry, 'id' | 'menuItemId' | 'menuItemName' | 'action' | 'at'>,
  ): void {
    const comment = fields.comment?.trim();
    if (MANDATORY_COMMENT_ACTIONS.has(action) && !comment) {
      throw new MenuError('Un commentaire est requis pour justifier cette modification de stock.', 400);
    }
    state.stockHistory.push({
      id: generateId('sh'),
      menuItemId: item.id,
      menuItemName: item.name,
      action,
      at: new Date().toISOString(),
      ...fields,
      comment,
    });
  }

  /** Pure read — safe to call outside db.mutate(). Normal service (no eventId) always reads the item's
   * own fields; an évènement with no override yet also reads those, since it hasn't diverged. */
  function readEffectiveStock(state: DbShape, item: MenuItem, eventId?: string): EventStockEntry {
    const inherited = { stockQuantity: item.stockQuantity, isAvailable: item.isAvailable };
    if (!eventId) return inherited;
    return state.events.find((e) => e.id === eventId)?.eventStock?.[item.id] ?? inherited;
  }

  /** Only call from inside db.mutate(). Writes to the item itself for normal service, or to its
   * per-évènement override (auto-created on first touch) otherwise — the catalogue entry (name/price/
   * category/…) is never touched either way, only these two fields. */
  function writeStock(state: DbShape, item: MenuItem, eventId: string | undefined, next: EventStockEntry): void {
    if (!eventId) {
      item.stockQuantity = next.stockQuantity;
      item.isAvailable = next.isAvailable;
      return;
    }
    const event = state.events.find((e) => e.id === eventId);
    if (!event) throw new MenuError('Évènement introuvable.', 404);
    (event.eventStock ??= {})[item.id] = next;
  }

  /** The item as it should be reported to the caller — its catalogue fields plus whichever stock actually applies. */
  function withEffectiveStock(item: MenuItem, eff: EventStockEntry): MenuItem {
    return eff.stockQuantity === item.stockQuantity && eff.isAvailable === item.isAvailable ? item : { ...item, ...eff };
  }

  return {
    MenuError,

    /** The shared catalogue, with each item's stock/availability resolved for the given évènement
     * (or normal service's own values when eventId is absent). */
    list(eventId?: string): MenuItem[] {
      return db.data.menu.map((item) => withEffectiveStock(item, readEffectiveStock(db.data, item, eventId)));
    },

    create(input: CreateMenuItemInput): MenuItem {
      if (!input.name?.trim()) throw new MenuError('Le nom est requis.', 400);
      if (!Number.isFinite(input.price) || input.price < 0) {
        throw new MenuError('Le prix doit être un nombre positif.', 400);
      }
      const item: MenuItem = {
        id: generateId('m'),
        name: input.name.trim(),
        category: input.category,
        price: input.price,
        stockQuantity: Math.max(0, input.stockQuantity),
        isAvailable: true,
        image: input.image ?? '',
        description: input.description ?? '',
        ingredients: input.ingredients ?? [],
      };
      return db.mutate((state) => {
        state.menu.push(item);
        return item;
      });
    },

    /** A price change requires `opts.comment` — throws before anything is saved if it's missing. */
    update(id: string, input: UpdateMenuItemInput, opts: { comment?: string; actor?: StockActor } = {}): MenuItem {
      if (input.name !== undefined && !input.name.trim()) {
        throw new MenuError('Le nom est requis.', 400);
      }
      if (input.price !== undefined && (!Number.isFinite(input.price) || input.price < 0)) {
        throw new MenuError('Le prix doit être un nombre positif.', 400);
      }
      let previousImage: string | undefined;
      const updated = db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        previousImage = item.image;
        const priceBefore = item.price;
        if (input.name !== undefined) item.name = input.name.trim();
        if (input.category !== undefined) item.category = input.category;
        if (input.image !== undefined) item.image = input.image;
        if (input.description !== undefined) item.description = input.description;
        if (input.ingredients !== undefined) item.ingredients = input.ingredients;
        if (input.price !== undefined && input.price !== priceBefore) {
          item.price = input.price;
          recordHistory(state, item, 'PRICE_CHANGE', {
            priceBefore,
            priceAfter: item.price,
            comment: opts.comment,
            userId: opts.actor?.userId,
            userName: opts.actor?.userName,
          });
        }
        return item;
      });
      if (input.image !== undefined && input.image !== previousImage) {
        deleteUploadedImageIfLocal(previousImage);
      }
      return updated;
    },

    remove(id: string): void {
      let removedImage: string | undefined;
      db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        removedImage = item.image;
        state.menu = state.menu.filter((m) => m.id !== id);
        for (const event of state.events) delete event.eventStock?.[id];
      });
      deleteUploadedImageIfLocal(removedImage);
    },

    /** Direct override of the stock count — always requires `comment`. */
    setStock(id: string, quantity: number, comment: string | undefined, actor?: StockActor, eventId?: string): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        const current = readEffectiveStock(state, item, eventId);
        const quantityBefore = current.stockQuantity;
        const quantityAfter = Math.max(0, quantity);
        const next: EventStockEntry = { stockQuantity: quantityAfter, isAvailable: current.isAvailable };
        writeStock(state, item, eventId, next);
        recordHistory(state, item, 'SET', {
          quantityBefore,
          quantityAfter,
          comment,
          userId: actor?.userId,
          userName: actor?.userName,
          eventId,
        });
        return withEffectiveStock(item, next);
      });
    },

    /** The +/- quick-adjust buttons — always requires `comment`. */
    adjustStock(id: string, delta: number, comment: string | undefined, actor?: StockActor, eventId?: string): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        const current = readEffectiveStock(state, item, eventId);
        const quantityBefore = current.stockQuantity;
        const quantityAfter = Math.max(0, quantityBefore + delta);
        const next: EventStockEntry = { stockQuantity: quantityAfter, isAvailable: current.isAvailable };
        writeStock(state, item, eventId, next);
        recordHistory(state, item, 'ADJUST', {
          quantityBefore,
          quantityAfter,
          comment,
          userId: actor?.userId,
          userName: actor?.userName,
          eventId,
        });
        return withEffectiveStock(item, next);
      });
    },

    setAvailability(id: string, isAvailable: boolean, actor?: StockActor, eventId?: string): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        const quantity = readEffectiveStock(state, item, eventId).stockQuantity;
        const next: EventStockEntry = { stockQuantity: quantity, isAvailable };
        writeStock(state, item, eventId, next);
        recordHistory(state, item, 'AVAILABILITY', { userId: actor?.userId, userName: actor?.userName, eventId });
        return withEffectiveStock(item, next);
      });
    },

    markOutOfStock(id: string, actor?: StockActor, eventId?: string): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        const current = readEffectiveStock(state, item, eventId);
        const quantityBefore = current.stockQuantity;
        const next: EventStockEntry = { stockQuantity: 0, isAvailable: current.isAvailable };
        writeStock(state, item, eventId, next);
        recordHistory(state, item, 'OUT_OF_STOCK', {
          quantityBefore,
          quantityAfter: 0,
          userId: actor?.userId,
          userName: actor?.userName,
          eventId,
        });
        return withEffectiveStock(item, next);
      });
    },

    /** Réapprovisionnement — always requires `comment`. */
    restock(id: string, quantity: number, comment: string | undefined, actor?: StockActor, eventId?: string): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        const current = readEffectiveStock(state, item, eventId);
        const quantityBefore = current.stockQuantity;
        const quantityAfter = Math.max(0, quantity);
        const next: EventStockEntry = { stockQuantity: quantityAfter, isAvailable: current.isAvailable };
        writeStock(state, item, eventId, next);
        recordHistory(state, item, 'RESTOCK', {
          quantityBefore,
          quantityAfter,
          comment,
          userId: actor?.userId,
          userName: actor?.userName,
          eventId,
        });
        return withEffectiveStock(item, next);
      });
    },

    /** Automatic deduction on order submission — no comment, references the order instead. */
    decrementForItems(
      items: { menuItemId: string; quantity: number }[],
      order?: { id: string; orderNumber: string },
      eventId?: string,
    ): void {
      db.mutate((state) => {
        for (const m of state.menu) {
          const totalQty = items.filter((i) => i.menuItemId === m.id).reduce((sum, i) => sum + i.quantity, 0);
          if (totalQty === 0) continue;
          const current = readEffectiveStock(state, m, eventId);
          const quantityBefore = current.stockQuantity;
          const quantityAfter = Math.max(0, quantityBefore - totalQty);
          const next: EventStockEntry = { stockQuantity: quantityAfter, isAvailable: current.isAvailable };
          writeStock(state, m, eventId, next);
          recordHistory(state, m, 'ORDER_DECREMENT', {
            quantityBefore,
            quantityAfter,
            orderId: order?.id,
            orderNumber: order?.orderNumber,
            eventId,
          });
        }
      });
    },

    /** Full log, or scoped to one item — newest first. */
    listHistory(menuItemId?: string): StockHistoryEntry[] {
      const entries = menuItemId ? db.data.stockHistory.filter((h) => h.menuItemId === menuItemId) : db.data.stockHistory;
      return entries.slice().sort((a, b) => b.at.localeCompare(a.at));
    },
  };
}

export type MenuService = ReturnType<typeof createMenuService>;
