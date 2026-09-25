import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { enforceEventManagerScope, resolveEventContext } from '../middleware/event.middleware';
import { requireRole } from '../middleware/role.middleware';
import { searchImageLibrary } from '../middleware/upload.middleware';
import { MenuError } from '../services/menu.service';
import { broadcastMenu } from '../sockets/io';

export const menuRouter = Router();

menuRouter.use(requireAuth);
menuRouter.use(resolveEventContext);
// EVENT_MANAGER gets full ADMIN-equivalent access below (requireRole treats them the same) — this is
// the one thing that survives that: reject an X-Event-Id scoped to an évènement they aren't assigned to.
menuRouter.use(enforceEventManagerScope);

function handle(req: Request, res: Response, fn: () => unknown, status = 200): void {
  try {
    const result = fn();
    broadcastMenu(req.etablissementId!);
    res.status(status).json(result);
  } catch (err) {
    if (err instanceof MenuError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}

menuRouter.get('/', (req, res) => {
  res.json(req.etablissement!.menu.list(req.eventId));
});

menuRouter.post('/', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const { name, category, price, stockQuantity, image, description, ingredients } = req.body ?? {};
  if (!name || !category || price === undefined || stockQuantity === undefined) {
    res.status(400).json({ error: 'name, category, price et stockQuantity sont requis.' });
    return;
  }
  handle(
    req,
    res,
    () =>
      req.etablissement!.menu.create({
        name,
        category,
        price: Number(price),
        stockQuantity: Number(stockQuantity),
        image,
        description,
        ingredients: Array.isArray(ingredients) ? ingredients.filter(Boolean) : undefined,
      }),
    201,
  );
});

menuRouter.put('/:id', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const { name, category, price, image, description, ingredients, comment } = req.body ?? {};
  handle(req, res, () =>
    req.etablissement!.menu.update(
      req.params.id,
      {
        name,
        category,
        price: price === undefined ? undefined : Number(price),
        image,
        description,
        ingredients: Array.isArray(ingredients) ? ingredients.filter(Boolean) : undefined,
      },
      { comment, actor: { userId: req.user!.sub, userName: req.user!.name } },
    ),
  );
});

menuRouter.delete('/:id', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  handle(req, res, () => {
    req.etablissement!.menu.remove(req.params.id);
    return { ok: true };
  });
});

menuRouter.patch('/:id/stock', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const { quantity, comment } = req.body as { quantity?: number; comment?: string };
  if (quantity === undefined) {
    res.status(400).json({ error: 'quantity est requis.' });
    return;
  }
  handle(req, res, () =>
    req.etablissement!.menu.setStock(
      req.params.id,
      Number(quantity),
      comment,
      { userId: req.user!.sub, userName: req.user!.name },
      req.eventId,
    ),
  );
});

menuRouter.patch('/:id/adjust', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const { delta, comment } = req.body as { delta?: number; comment?: string };
  if (delta === undefined) {
    res.status(400).json({ error: 'delta est requis.' });
    return;
  }
  handle(req, res, () =>
    req.etablissement!.menu.adjustStock(
      req.params.id,
      Number(delta),
      comment,
      { userId: req.user!.sub, userName: req.user!.name },
      req.eventId,
    ),
  );
});

menuRouter.patch('/:id/availability', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const { isAvailable } = req.body as { isAvailable?: boolean };
  if (isAvailable === undefined) {
    res.status(400).json({ error: 'isAvailable est requis.' });
    return;
  }
  handle(req, res, () =>
    req.etablissement!.menu.setAvailability(
      req.params.id,
      Boolean(isAvailable),
      { userId: req.user!.sub, userName: req.user!.name },
      req.eventId,
    ),
  );
});

menuRouter.patch('/:id/out-of-stock', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  handle(req, res, () =>
    req.etablissement!.menu.markOutOfStock(
      req.params.id,
      { userId: req.user!.sub, userName: req.user!.name },
      req.eventId,
    ),
  );
});

menuRouter.patch('/:id/restock', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const { quantity, comment } = req.body as { quantity?: number; comment?: string };
  handle(req, res, () =>
    req.etablissement!.menu.restock(
      req.params.id,
      Number(quantity ?? 20),
      comment,
      { userId: req.user!.sub, userName: req.user!.name },
      req.eventId,
    ),
  );
});

/** Full stock/price history, optionally scoped to one item via ?menuItemId=. */
menuRouter.get('/history', (req, res) => {
  const menuItemId = typeof req.query.menuItemId === 'string' ? req.query.menuItemId : undefined;
  res.json(req.etablissement!.menu.listHistory(menuItemId));
});

/** Shared stock-photo library, searched live by filename — ?q=<texte tapé>. Not tied to any one
 * établissement: an operator grows it by dropping files straight into the server's image-library folder. */
menuRouter.get('/image-library', requireRole('KITCHEN', 'COMPTOIR'), (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(searchImageLibrary(q));
});
