import fs from 'node:fs';
import path from 'node:path';
import { IEtablissementDatabase } from '../data/db';
import { MenuCategory, MenuItem } from '../models/types';
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

  return {
    MenuError,

    list(): MenuItem[] {
      return db.data.menu;
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
        isAvailable: input.stockQuantity > 0,
        image: input.image ?? '',
        description: input.description ?? '',
        ingredients: input.ingredients ?? [],
      };
      return db.mutate((state) => {
        state.menu.push(item);
        return item;
      });
    },

    update(id: string, input: UpdateMenuItemInput): MenuItem {
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
        if (input.name !== undefined) item.name = input.name.trim();
        if (input.category !== undefined) item.category = input.category;
        if (input.price !== undefined) item.price = input.price;
        if (input.image !== undefined) item.image = input.image;
        if (input.description !== undefined) item.description = input.description;
        if (input.ingredients !== undefined) item.ingredients = input.ingredients;
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
      });
      deleteUploadedImageIfLocal(removedImage);
    },

    setStock(id: string, quantity: number): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        item.stockQuantity = Math.max(0, quantity);
        item.isAvailable = item.stockQuantity > 0;
        return item;
      });
    },

    adjustStock(id: string, delta: number): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        item.stockQuantity = Math.max(0, item.stockQuantity + delta);
        item.isAvailable = item.stockQuantity > 0;
        return item;
      });
    },

    setAvailability(id: string, isAvailable: boolean): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        item.isAvailable = isAvailable;
        return item;
      });
    },

    markOutOfStock(id: string): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        item.isAvailable = false;
        item.stockQuantity = 0;
        return item;
      });
    },

    restock(id: string, quantity: number): MenuItem {
      return db.mutate((state) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) throw new MenuError('Article introuvable.', 404);
        item.isAvailable = true;
        item.stockQuantity = Math.max(0, quantity);
        return item;
      });
    },

    decrementForItems(items: { menuItemId: string; quantity: number }[]): void {
      db.mutate((state) => {
        for (const m of state.menu) {
          const totalQty = items.filter((i) => i.menuItemId === m.id).reduce((sum, i) => sum + i.quantity, 0);
          if (totalQty === 0) continue;
          m.stockQuantity = Math.max(0, m.stockQuantity - totalQty);
          m.isAvailable = m.stockQuantity > 0;
        }
      });
    },
  };
}

export type MenuService = ReturnType<typeof createMenuService>;
