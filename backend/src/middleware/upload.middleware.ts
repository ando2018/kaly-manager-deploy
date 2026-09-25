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
