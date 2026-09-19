import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Request } from 'express';
import { generateId } from '../utils/id';

const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
