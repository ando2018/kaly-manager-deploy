export type UserRole = 'WAITER' | 'KITCHEN' | 'CASHIER' | 'ADMIN' | 'COMPTOIR';

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
 * An évènement is an isolated operational layer on top of the normal service: it shares the same
 * menu/stock and order pipeline, but any order created under it only appears to the staff assigned
 * to it (Cuisine/Caisse/Comptoir/Suivi Global), separate from normal-service orders and other events.
 */
export interface RestaurantEvent {
  id: string;
  name: string;
  description?: string;
  status: EventStatus;
  createdAt: string;
  createdBy?: string;
  assignedUserIds: string[];
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
}
