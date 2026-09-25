import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Counters, DbShape, LegacyDbShape, MenuItem, Order, User } from '../models/types';
import { generateId } from '../utils/id';
import { UPLOADS_PUBLIC_PATH } from '../middleware/upload.middleware';

function hashPin(pin: string): string {
  return bcrypt.hashSync(pin, 8);
}

/** A brand-new établissement starts empty, with a single admin account (the director) to set everything up. */
export function buildFreshSeed(adminName?: string): DbShape {
  const now = new Date().toISOString();
  return {
    users: [
      {
        id: generateId('u'),
        name: adminName?.trim() || 'Administrateur',
        role: 'ADMIN',
        pinHash: hashPin('0000'),
        createdAt: now,
        mustChangePin: true,
      },
    ],
    menu: [],
    orders: [],
    events: [],
    waiterAlerts: [],
    kitchenAlerts: [],
    counters: { table: 0, order: 0 },
    theme: 'emerald',
    stockHistory: [],
  };
}

/** Rich demo dataset — used only to seed the sample/demo établissement. */
export function buildDemoSeed(): DbShape {
  const now = new Date();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const datePrefix = `${dd}${mm}${yy}`;

  const users: User[] = [
    { id: 'u1', name: 'Jean (Serveur)', role: 'WAITER', pinHash: hashPin('1111'), createdAt: now.toISOString() },
    { id: 'u2', name: 'Chef Mario (Cuisine)', role: 'KITCHEN', pinHash: hashPin('2222'), createdAt: now.toISOString() },
    { id: 'u3', name: 'Sophie (Caisse)', role: 'CASHIER', pinHash: hashPin('3333'), createdAt: now.toISOString() },
    { id: 'u4', name: 'Alex (Directeur / Admin)', role: 'ADMIN', pinHash: hashPin('0000'), createdAt: now.toISOString() },
    { id: 'u5', name: 'Nina (Comptoir)', role: 'COMPTOIR', pinHash: hashPin('4444'), createdAt: now.toISOString() },
  ];

  const menu: MenuItem[] = [
    {
      id: 'm1',
      name: 'Burger Gourmet & Frites Maison',
      category: 'MAIN',
      price: 18.5,
      stockQuantity: 25,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80',
      description: "Bœuf origine France, cheddar affiné, sauce secrète",
      ingredients: ['Pain brioché', 'Bœuf haché', 'Cheddar', 'Salade', 'Tomate', 'Sauce secrète', 'Frites maison'],
    },
    {
      id: 'm2',
      name: "Entrecôte 300g Beurre Maître d'Hôtel",
      category: 'MAIN',
      price: 26.0,
      stockQuantity: 4,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&q=80',
      description: 'Servie avec frites fraîches et salade',
      ingredients: ['Entrecôte de bœuf 300g', "Beurre maître d'hôtel", 'Frites fraîches', 'Salade verte'],
    },
    {
      id: 'm3',
      name: 'Salade Caesar Poulet Croustillant',
      category: 'MAIN',
      price: 15.0,
      stockQuantity: 0,
      isAvailable: false,
      image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80',
      description: 'Poulet pané, parmesan, croûtons, sauce maison',
      ingredients: ['Poulet pané', 'Salade romaine', 'Parmesan', 'Croûtons', 'Sauce Caesar maison'],
    },
    {
      id: 'm4',
      name: 'Tartare de Thon Rouge & Avocat',
      category: 'ENTREE',
      price: 14.5,
      stockQuantity: 12,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=600&q=80',
      description: "Thon frais, huile de sésame, piment d'Espelette",
      ingredients: ['Thon rouge frais', 'Avocat', 'Huile de sésame', "Piment d'Espelette", 'Citron vert'],
    },
    {
      id: 'm5',
      name: 'Tiramisu Tradizionale',
      category: 'DESSERT',
      price: 8.0,
      stockQuantity: 18,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=600&q=80',
      description: 'Café espresso, mascarpone, cacao amer',
      ingredients: ['Biscuits cuillère', 'Café espresso', 'Mascarpone', 'Œufs', 'Cacao amer'],
    },
    {
      id: 'm6',
      name: 'Cocktail Signature "Bistro Glow"',
      category: 'DRINK',
      price: 10.5,
      stockQuantity: 50,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?w=600&q=80',
      description: 'Gin, sirop de basilic maison, jus de citron vert, prosecco',
      ingredients: ['Gin', 'Sirop de basilic maison', 'Jus de citron vert', 'Prosecco'],
    },
    {
      id: 'm7',
      name: 'Velouté de Potiron & Noisettes',
      category: 'ENTREE',
      price: 9.5,
      stockQuantity: 15,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1476718406336-bb5a9690ee2a?w=600&q=80',
      description: 'Crème fraîche, noisettes torréfiées, huile de truffe',
      ingredients: ['Potiron', 'Crème fraîche', 'Noisettes torréfiées', 'Huile de truffe', 'Bouillon de légumes'],
    },
    {
      id: 'm8',
      name: 'Risotto Crémeux aux Champignons',
      category: 'MAIN',
      price: 17.0,
      stockQuantity: 3,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1476124369491-e7addf5db371?w=600&q=80',
      description: 'Cèpes, parmesan 24 mois, huile de persil',
      ingredients: ['Riz arborio', 'Cèpes', 'Parmesan 24 mois', 'Huile de persil', 'Bouillon de volaille'],
    },
    {
      id: 'm9',
      name: 'Fondant au Chocolat Cœur Coulant',
      category: 'DESSERT',
      price: 9.0,
      stockQuantity: 20,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1624353365286-3f8d62daad51?w=600&q=80',
      description: 'Servi tiède, glace vanille bourbon',
      ingredients: ['Chocolat noir', 'Beurre', 'Œufs', 'Sucre', 'Glace vanille bourbon'],
    },
    {
      id: 'm10',
      name: 'Limonade Artisanale Maison',
      category: 'DRINK',
      price: 5.5,
      stockQuantity: 40,
      isAvailable: true,
      image: 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=600&q=80',
      description: 'Citron pressé, menthe fraîche, eau pétillante',
      ingredients: ['Citron pressé', 'Menthe fraîche', 'Eau pétillante', 'Sirop de sucre de canne'],
    },
  ];

  const orders: Order[] = [
    {
      id: 'o101',
      orderNumber: `T-${datePrefix}-87`,
      type: 'TABLE',
      tableNumber: 4,
      guestCount: 3,
      status: 'IN_PREPARATION',
      createdAt: minutesAgo(15),
      totalAmount: 44.5,
      waiterId: 'u1',
      waiterName: 'Jean',
      statusHistory: [
        { status: 'SENT', at: minutesAgo(15) },
        { status: 'IN_PREPARATION', at: minutesAgo(10) },
      ],
      items: [
        {
          id: generateId('i'),
          menuItemId: 'm1',
          name: 'Burger Gourmet',
          quantity: 1,
          unitPrice: 18.5,
          options: ['Cuisson Saignant'],
          kitchenNote: 'Sans oignons svp',
          status: 'IN_PREPARATION',
        },
        {
          id: generateId('i'),
          menuItemId: 'm2',
          name: 'Entrecôte 300g',
          quantity: 1,
          unitPrice: 26.0,
          options: ['Cuisson A point'],
          status: 'IN_PREPARATION',
        },
      ],
      messages: [
        {
          id: generateId('msg'),
          orderId: 'o101',
          senderRole: 'WAITER',
          content: 'Client pressé pour la table 4',
          timestamp: minutesAgo(12),
          isUrgent: true,
        },
      ],
    },
    {
      id: 'o102',
      orderNumber: `EMP-${datePrefix}-88`,
      type: 'EPHEMERAL',
      customerName: 'Thomas (A emporter)',
      status: 'READY',
      createdAt: minutesAgo(8),
      totalAmount: 18.5,
      waiterId: 'u1',
      waiterName: 'Jean',
      statusHistory: [
        { status: 'SENT', at: minutesAgo(8) },
        { status: 'IN_PREPARATION', at: minutesAgo(6) },
        { status: 'READY', at: minutesAgo(3) },
      ],
      items: [
        {
          id: generateId('i'),
          menuItemId: 'm1',
          name: 'Burger Gourmet',
          quantity: 1,
          unitPrice: 18.5,
          options: ['Sauce à part'],
          status: 'READY',
        },
      ],
      messages: [],
    },
  ];

  return {
    users,
    menu,
    orders,
    events: [],
    waiterAlerts: [],
    kitchenAlerts: [],
    counters: { table: 4, order: 88 },
    theme: 'emerald',
    stockHistory: [],
  };
}

/** Backfills statusHistory on orders persisted before that field existed. */
export function migrate(data: DbShape): boolean {
  let changed = false;
  for (const order of data.orders as (Order & { statusHistory?: Order['statusHistory'] })[]) {
    if (order.statusHistory?.length) continue;
    changed = true;
    order.statusHistory = [{ status: 'SENT', at: order.createdAt }];
    if (order.status !== 'SENT') {
      const at = order.payment?.paidAt ?? order.createdAt;
      order.statusHistory.push({ status: order.status, at });
    }
  }

  // Pre-rename counter: the "ephemeral" order-numbering counter is now the shared "order" counter.
  const counters = data.counters as Counters & { ephemeral?: number };
  if (counters.order === undefined) {
    counters.order = counters.ephemeral ?? 0;
    delete counters.ephemeral;
    changed = true;
  }

  if (!data.theme) {
    data.theme = 'emerald';
    changed = true;
  }

  if (!data.events) {
    data.events = [];
    changed = true;
  }

  if (!data.stockHistory) {
    data.stockHistory = [];
    changed = true;
  }

  // Per-évènement stock moved from the root (eventId -> menuItemId -> entry) into each évènement.
  // Entries for évènements that no longer exist are dropped rather than carried over.
  const legacy = data as LegacyDbShape;
  if (legacy.eventStock) {
    for (const [eventId, perItem] of Object.entries(legacy.eventStock)) {
      const event = data.events.find((e) => e.id === eventId);
      if (event && Object.keys(perItem).length) event.eventStock = { ...perItem, ...event.eventStock };
    }
    delete legacy.eventStock;
    changed = true;
  }

  // Uploaded-image URLs used to freeze whatever host/port served the upload request (e.g.
  // "http://192.168.1.198:3000/uploads/..."), which breaks the moment the server is reached from
  // a different host. Strip that prefix down to the relative path the frontend now expects.
  const uploadMarker = `${UPLOADS_PUBLIC_PATH}/`;
  for (const item of data.menu) {
    if (!item.image) continue;
    const idx = item.image.indexOf(uploadMarker);
    if (idx > 0) {
      item.image = item.image.slice(idx);
      changed = true;
    }
  }

  return changed;
}

/**
 * Storage-backend-agnostic surface every service depends on — implemented by `JsonDatabase`
 * (local file) and `FirestoreDatabase` (cloud), so services never know which one they're using.
 */
export interface IEtablissementDatabase {
  readonly data: DbShape;
  mutate<T>(fn: (state: DbShape) => T): T;
}

export class JsonDatabase implements IEtablissementDatabase {
  private state: DbShape;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dbPath: string,
    seedFn: () => DbShape,
  ) {
    this.state = this.load(seedFn);
  }

  private load(seedFn: () => DbShape): DbShape {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    if (!fs.existsSync(this.dbPath)) {
      const seed = seedFn();
      fs.writeFileSync(this.dbPath, JSON.stringify(seed, null, 2), 'utf-8');
      return seed;
    }
    const raw = fs.readFileSync(this.dbPath, 'utf-8');
    const data = JSON.parse(raw) as DbShape;
    if (migrate(data)) {
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf-8');
    }
    return data;
  }

  private persist(): void {
    this.writeQueue = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          fs.writeFile(this.dbPath, JSON.stringify(this.state, null, 2), 'utf-8', (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    );
  }

  get data(): DbShape {
    return this.state;
  }

  /** Mutate the in-memory state and persist to disk. */
  mutate<T>(fn: (state: DbShape) => T): T {
    const result = fn(this.state);
    this.persist();
    return result;
  }
}
