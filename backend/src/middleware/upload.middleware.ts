import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Request } from 'express';
import { generateId } from '../utils/id';

const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/** Shared across every établissement — a stock-photo library an operator can grow by simply dropping
 * files into this folder on the server (no upload flow, no restart needed: the search route below
 * reads the directory fresh on every request). */
const IMAGE_LIBRARY_DIR = path.resolve(__dirname, '..', '..', 'image-library');
fs.mkdirSync(IMAGE_LIBRARY_DIR, { recursive: true });

const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export function etablissementUploadsDir(etablissementId: string): string {
  return path.join(UPLOADS_DIR, etablissementId);
}

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const dir = etablissementUploadsDir(req.etablissementId!);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype] ?? path.extname(file.originalname) ?? '';
    cb(null, `${generateId('img')}${ext}`);
  },
});

export const imageUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TO_EXT[file.mimetype]) {
      cb(new Error("Format d'image non supporté (JPEG, PNG, WEBP ou GIF uniquement)."));
      return;
    }
    cb(null, true);
  },
});

export const UPLOADS_PUBLIC_PATH = '/uploads';
export const UPLOADS_DISK_PATH = UPLOADS_DIR;

export const IMAGE_LIBRARY_PUBLIC_PATH = '/image-library';
export const IMAGE_LIBRARY_DISK_PATH = IMAGE_LIBRARY_DIR;

const LIBRARY_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/** Strips accents/case/separators so "Crêpe-Sucre.jpg" and a search for "crepe sucre" both normalize
 * to "crepe sucre", making the match forgiving without needing any real fuzzy-matching library. */
function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .trim();
}

export interface LibraryImage {
  name: string;
  url: string;
}

/** Live directory read on every call — a file dropped into IMAGE_LIBRARY_DIR shows up in results
 * immediately, no restart or cache invalidation needed. An empty query returns nothing (the library
 * isn't browsable by default — you have to search); "*" is the explicit "show everything" wildcard,
 * uncapped; any other query filters by substring match against the normalized filename, capped at `limit`. */
export function searchImageLibrary(query: string, limit = 60): LibraryImage[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  let files: string[];
  try {
    files = fs.readdirSync(IMAGE_LIBRARY_DIR);
  } catch {
    return [];
  }
  const showAll = trimmed === '*';
  const normalizedQuery = showAll ? '' : normalizeForSearch(trimmed);
  const results = files
    .filter((f) => LIBRARY_IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => ({ name: path.basename(f, path.extname(f)).replace(/[-_]+/g, ' ').trim(), url: `${IMAGE_LIBRARY_PUBLIC_PATH}/${f}` }))
    .filter((img) => showAll || normalizeForSearch(img.name).includes(normalizedQuery))
    .sort((a, b) => a.name.localeCompare(b.name));
  return showAll ? results : results.slice(0, limit);
}

/** Every library image with its size and date — for the platform admin's management screen. */
export function listImageLibrary(): (LibraryImage & { file: string; size: number; addedAt: string })[] {
  let files: string[];
  try {
    files = fs.readdirSync(IMAGE_LIBRARY_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => LIBRARY_IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => {
      const stat = fs.statSync(path.join(IMAGE_LIBRARY_DIR, f));
      return {
        file: f,
        name: path.basename(f, path.extname(f)).replace(/[-_]+/g, ' ').trim(),
        url: `${IMAGE_LIBRARY_PUBLIC_PATH}/${f}`,
        size: stat.size,
        addedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The file name is what staff search by: « Crêpe au sucre » → « crepe-au-sucre ». */
function slugifyImageName(value: string): string {
  return normalizeForSearch(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Library uploads land straight in IMAGE_LIBRARY_DIR, named after the product (never overwriting). */
export const libraryImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, IMAGE_LIBRARY_DIR),
    filename: (req: Request, file, cb) => {
      const ext = ALLOWED_MIME_TO_EXT[file.mimetype] ?? '.jpg';
      const requested = typeof req.body?.name === 'string' ? req.body.name : '';
      const base = slugifyImageName(requested || path.basename(file.originalname, path.extname(file.originalname))) || 'image';
      let candidate = `${base}${ext}`;
      for (let n = 2; fs.existsSync(path.join(IMAGE_LIBRARY_DIR, candidate)); n++) candidate = `${base}-${n}${ext}`;
      cb(null, candidate);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TO_EXT[file.mimetype]) {
      cb(new Error("Format d'image non supporté (JPEG, PNG, WEBP ou GIF uniquement)."));
      return;
    }
    cb(null, true);
  },
});

/** Deletes one library file. Refuses anything that isn't a plain image file name inside the folder. */
export function deleteLibraryImage(file: string): boolean {
  if (!file || file !== path.basename(file) || !LIBRARY_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  const full = path.join(IMAGE_LIBRARY_DIR, file);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}
