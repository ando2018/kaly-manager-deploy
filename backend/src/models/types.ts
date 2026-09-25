/** EVENT_MANAGER: admin-equivalent powers (orders, stock, team assignment) but only within whichever
 * évènement(s) they're assigned to — never normal service, never another évènement. */
export type UserRole = 'WAITER' | 'KITCHEN' | 'CASHIER' | 'ADMIN' | 'COMPTOIR' | 'EVENT_MANAGER';

export type OrderType = 'TABLE' | 'EPHEMERAL';

export type OrderStatus =
  | 'DRAFT'
  | 'SENT'
  | 'IN_PREPARATION'
  | 'READY'
  | 'DELIVERED'
  | 'PAID'
  | 'CANCELLED';

export type MenuCategory = 'ENTREE' | 'MAIN' | 'DESSERT' | 'DRINK' | 'AUTRES';

export type PaymentMethod = 'CB' | 'CASH' | 'TICKET_RESTAURANT' | 'MOBILE_PASS';

export type ThemeId =
  | 'emerald'
  | 'bordeaux'
  | 'bistro-ambre'
  | 'ocean'
  | 'oliveraie'
  | 'truffe-doree'
  | 'lavande'
  | 'noir-blanc'
  | 'sepia'
  | 'neon'
  | 'rose-poudre'
  | 'custom';

/** The core colors an établissement picks manually to build its own theme — the rest of the palette is derived from these. */
export interface CustomThemeColors {
  background: string;
  accent: string;
  secondary: string;
  text: string;
}

export interface User {
  id: string;
  name: string;
  role: UserRole;
  pinHash: string;
  createdAt: string;
  suspended?: boolean;
  mustChangePin?: boolean;
}

export type PublicUser = Omit<User, 'pinHash'>;

export interface MenuItem {
  id: string;
  name: string;
  category: MenuCategory;
  price: number;
  stockQuantity: number;
  isAvailable: boolean;
  image: string;
  description: string;
  ingredients: string[];
}

export type StockActionType =
  | 'RESTOCK'
  | 'ADJUST'
  | 'SET'
  | 'PRICE_CHANGE'
  | 'ORDER_DECREMENT'
  | 'OUT_OF_STOCK'
  | 'AVAILABILITY';

/**
 * One entry per stock- or price-affecting action on a menu item. RESTOCK/ADJUST/SET/PRICE_CHANGE
 * are manual staff actions and always carry a mandatory `comment` (enforced in menu.service.ts);
 * ORDER_DECREMENT is the automatic deduction from a paid order and carries `orderId` instead.
 */
export interface StockHistoryEntry {
  id: string;
  menuItemId: string;
  menuItemName: string;
  action: StockActionType;
  quantityBefore?: number;
  quantityAfter?: number;
  priceBefore?: number;
  priceAfter?: number;
  comment?: string;
  userId?: string;
  userName?: string;
  orderId?: string;
  orderNumber?: string;
  /** Absent = normal service. Which évènement's stock this particular entry actually changed. */
  eventId?: string;
  at: string;
}

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  options?: string[];
  kitchenNote?: string;
  status: OrderStatus;
  /** Set once this item's round has been served — lets the KDS hide it when later items are added to the same order. */
  deliveredAt?: string;
}

export interface KitchenMessage {
  id: string;
  orderId: string;
  senderRole: 'WAITER' | 'KITCHEN';
  content: string;
  timestamp: string;
  isUrgent?: boolean;
}

export interface OrderPayment {
  method: PaymentMethod;
  paidAmount: number;
  paidAt: string;
  split?: boolean;
}

export interface OrderStatusEvent {
  status: OrderStatus;
  at: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  type: OrderType;
  tableNumber?: number;
  guestCount?: number;
  customerName?: string;
  status: OrderStatus;
  items: OrderItem[];
  messages: KitchenMessage[];
  totalAmount: number;
  createdAt: string;
  waiterId?: string;
  waiterName?: string;
  kitchenStaffId?: string;
  kitchenStaffName?: string;
  payment?: OrderPayment;
  statusHistory: OrderStatusEvent[];
  cancelReason?: string;
  cancelledBy?: string;
  /** ADMIN-only "direct to caisse" flow: skips kitchen entirely, paid up front, picked up later at the counter. */
  isCounterOrder?: boolean;
  pickedUpAt?: string;
  /** Set when this order was created while the staff member was working under an évènement — omitted for normal service. */
  eventId?: string;
}

export type EventStatus = 'ACTIVE' | 'CLOSED';

/**
 * STANDARD: Serveur → Cuisine → Prêt → Servie → Caisse (the normal table-service pipeline).
 * COUNTER: Caisse → Génération ticket → Récupération comptoir — every order placed under this
 * évènement skips the kitchen entirely and is ready for pickup immediately (see orders.service.ts submit()).
 */
export type EventServiceType = 'STANDARD' | 'COUNTER';

/**
 * An évènement is an isolated operational layer on top of the normal service: it shares the same
 * menu/stock and order pipeline, but any order created under it only appears to the staff assigned
 * to it (Cuisine/Caisse/Comptoir/Suivi Global), separate from normal-service orders and other events.
 */
export interface RestaurantEvent {
  id: string;
  name: string;
  description?: string;
  status: EventStatus;
  /** Absent on events created before this field existed — treat as STANDARD. */
  serviceType?: EventServiceType;
  /** STANDARD-only: how many tables this évènement seats — drives the table map in Suivi Global. */
  tableCount?: number;
  createdAt: string;
  createdBy?: string;
  assignedUserIds: string[];
  /** menuItemId -> this évènement's own stock. The product list itself is shared by the whole
   * établissement; an item with no entry here inherits the menu item's own stockQuantity/isAvailable
   * (normal service's values) until this évènement's stock is first touched. Never sent to clients. */
  eventStock?: Record<string, EventStockEntry>;
}

export interface WaiterAlert {
  id: string;
  orderId: string;
  orderLabel: string;
  message: string;
  timestamp: string;
  /** Targeted recipient — set on waiterAlerts (kitchen → waiter) so only that waiter (or an admin) sees it. */
  targetUserId?: string;
}

export interface Counters {
  table: number;
  order: number;
}

/** One évènement's independent stock for one menu item — the catalogue entry itself (name/price/
 * category/…) always stays shared across the whole établissement; only these two fields can diverge. */
export interface EventStockEntry {
  stockQuantity: number;
  isAvailable: boolean;
}

export interface DbShape {
  users: User[];
  menu: MenuItem[];
  orders: Order[];
  events: RestaurantEvent[];
  waiterAlerts: WaiterAlert[];
  kitchenAlerts: WaiterAlert[];
  counters: Counters;
  theme: ThemeId;
  customTheme?: CustomThemeColors;
  /** The organization's own logo — shown in the sidebar brand mark in place of the default "KM" mark. */
  logoUrl?: string;
  stockHistory: StockHistoryEntry[];
  /** Set once "Disponible à la vente" stopped being auto-unchecked by stock hitting 0 (see migrate()). */
  availabilityDecoupled?: boolean;
}

/** Pre-migration shape: per-évènement stock used to live at the root, keyed by eventId. */
export interface LegacyDbShape extends DbShape {
  eventStock?: Record<string, Record<string, EventStockEntry>>;
}
