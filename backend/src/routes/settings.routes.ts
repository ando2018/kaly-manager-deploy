import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { CustomThemeColors, ThemeId } from '../models/types';
import { etablissementUploadsDir, imageUpload, UPLOADS_PUBLIC_PATH } from '../middleware/upload.middleware';
import { broadcastLogo, broadcastTheme } from '../sockets/io';

const THEME_IDS: ThemeId[] = [
  'emerald',
  'bordeaux',
  'bistro-ambre',
  'ocean',
  'oliveraie',
  'truffe-doree',
  'lavande',
  'noir-blanc',
  'sepia',
  'neon',
  'rose-poudre',
  'custom',
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isValidCustomTheme(value: unknown): value is CustomThemeColors {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (['background', 'accent', 'secondary', 'text'] as const).every(
    (key) => typeof c[key] === 'string' && HEX_COLOR_RE.test(c[key] as string),
  );
}

export const settingsRouter = Router();

// Theme/logo are non-sensitive établissement branding, not staff data — reading them only needs
// resolveEtablissement (already applied where this router is mounted), not a staff PIN. That matters
// because the login screen shows the logo before anyone has authenticated (profile picker, PIN entry,
// évènement picker) — requiring a token here would mean it never loads until after login, too late for
// those screens. Every mutation below still requires an authenticated admin, same as before.
settingsRouter.get('/', (req, res) => {
  res.json({
    theme: req.etablissement!.db.data.theme ?? 'emerald',
    customTheme: req.etablissement!.db.data.customTheme,
    logoUrl: req.etablissement!.db.data.logoUrl,
  });
});

settingsRouter.patch('/theme', requireAuth, requireRole(), (req, res) => {
  const { theme, customTheme } = req.body as { theme?: string; customTheme?: unknown };
  if (!theme || !THEME_IDS.includes(theme as ThemeId)) {
    res.status(400).json({ error: 'Thème invalide.' });
    return;
  }
  if (theme === 'custom' && !isValidCustomTheme(customTheme)) {
    res.status(400).json({ error: 'Couleurs personnalisées invalides.' });
    return;
  }

  req.etablissement!.db.mutate((state) => {
    state.theme = theme as ThemeId;
    if (theme === 'custom') state.customTheme = customTheme as CustomThemeColors;
  });
  const persistedCustomTheme = theme === 'custom' ? (customTheme as CustomThemeColors) : undefined;
  broadcastTheme(req.etablissementId!, theme as ThemeId, persistedCustomTheme);
  res.json({ theme, customTheme: persistedCustomTheme });
});

/** Best-effort delete of a previously-uploaded logo file; no-op for external URLs. Mirrors the same
 * cleanup menu.service.ts does for a dish photo when it's replaced or removed. */
function deleteUploadedLogoIfLocal(etablissementId: string, logoUrl: string | undefined): void {
  if (!logoUrl) return;
  const marker = `${UPLOADS_PUBLIC_PATH}/${etablissementId}/`;
  const idx = logoUrl.indexOf(marker);
  if (idx === -1) return;
  const filename = logoUrl.slice(idx + marker.length).split(/[?#]/)[0];
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  fs.unlink(path.join(etablissementUploadsDir(etablissementId), filename), () => {
    // Ignore errors: file may already be gone, or shared/replaced — deletion is best-effort cleanup.
  });
}

settingsRouter.post('/logo', requireAuth, requireRole(), (req, res) => {
  imageUpload.single('image')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Échec de l'upload.";
      res.status(400).json({ error: message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Aucun fichier reçu.' });
      return;
    }
    const url = `${UPLOADS_PUBLIC_PATH}/${req.etablissementId}/${req.file.filename}`;
    const previousLogo = req.etablissement!.db.data.logoUrl;
    req.etablissement!.db.mutate((state) => {
      state.logoUrl = url;
    });
    if (previousLogo && previousLogo !== url) deleteUploadedLogoIfLocal(req.etablissementId!, previousLogo);
    broadcastLogo(req.etablissementId!, url);
    res.status(201).json({ url });
  });
});

settingsRouter.delete('/logo', requireAuth, requireRole(), (req, res) => {
  const previousLogo = req.etablissement!.db.data.logoUrl;
  req.etablissement!.db.mutate((state) => {
    state.logoUrl = undefined;
  });
  deleteUploadedLogoIfLocal(req.etablissementId!, previousLogo);
  broadcastLogo(req.etablissementId!, undefined);
  res.status(204).send();
});
