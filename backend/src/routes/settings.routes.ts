import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { CustomThemeColors, ThemeId } from '../models/types';
import { broadcastTheme } from '../sockets/io';

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

settingsRouter.use(requireAuth);

settingsRouter.get('/', (req, res) => {
  res.json({
    theme: req.etablissement!.db.data.theme ?? 'emerald',
    customTheme: req.etablissement!.db.data.customTheme,
  });
});

settingsRouter.patch('/theme', requireRole(), (req, res) => {
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
