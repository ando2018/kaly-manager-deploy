import { IEtablissementDatabase } from '../data/db';
import { KitchenMessage, Order, OrderItem, OrderStatus, OrderType, PaymentMethod, WaiterAlert } from '../models/types';
import { generateId } from '../utils/id';
import { MenuService } from './menu.service';

export interface NewOrderItemInput {
  menuItemId: string;
  quantity: number;
  options?: string[];
  kitchenNote?: string;
}

export interface NewOrderInput {
  type: OrderType;
  tableNumber?: number;
  guestCount?: number;
  customerName?: string;
  waiterId?: string;
  waiterName?: string;
  items: NewOrderItemInput[];
  orderNote?: string;
  /** EPHEMERAL-only: no kitchen/comptoir routing decided yet — created unpaid, resolved at Caisse. */
  draft?: boolean;
  /** Set when the submitting staff member is currently working under an évènement. */
  eventId?: string;
}

export class OrderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const NEXT_TICKET_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  SENT: 'IN_PREPARATION',
  IN_PREPARATION: 'READY',
  READY: 'DELIVERED',
};

function orderLabel(order: Order): string {
  return order.type === 'TABLE' ? `Table ${order.tableNumber}` : order.orderNumber;
}

/** Appends a status change to the order's timeline, unless it's a no-op repeat of the last entry. */
function recordStatus(order: Order, status: OrderStatus): void {
  const last = order.statusHistory[order.statusHistory.length - 1];
  if (last?.status === status) return;
  order.statusHistory.push({ status, at: new Date().toISOString() });
}

export function createOrdersService(db: IEtablissementDatabase, menuService: MenuService) {
  /** Order numbers are prefixed by type, date-stamped (ddmmyy) and end on a running per-établissement sequence: "T-170926-14" / "EMP-170926-15". */
  function generateOrderNumber(type: OrderType, tableNumber: number | undefined): string {
    if (type === 'TABLE' && (!tableNumber || tableNumber > db.data.counters.table)) {
      db.data.counters.table = tableNumber ?? db.data.counters.table + 1;
    }
    db.data.counters.order += 1;

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const prefix = type === 'TABLE' ? 'T' : 'EMP';
    return `${prefix}-${dd}${mm}${yy}-${db.data.counters.order}`;
  }

  const service = {
    OrderError,

    list(): Order[] {
      return db.data.orders;
    },

    get(id: string): Order | undefined {
      return db.data.orders.find((o) => o.id === id);
    },

    submit(input: NewOrderInput): Order {
      const order = db.mutate((state) => {
        const items: OrderItem[] = input.items.map((i) => {
          const menuItem = state.menu.find((m) => m.id === i.menuItemId);
          if (!menuItem) throw new OrderError(`Article introuvable: ${i.menuItemId}`, 400);
          return {
            id: generateId('i'),
            menuItemId: i.menuItemId,
            name: menuItem.name,
            quantity: i.quantity,
            unitPrice: menuItem.price,
            options: i.options,
            kitchenNote: i.kitchenNote,
            status: 'SENT' as OrderStatus,
          };
        });

        const totalAmount = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
        const createdAt = new Date().toISOString();
        const isDraft = input.type === 'EPHEMERAL' && input.draft;
        const initialStatus: OrderStatus = isDraft ? 'DRAFT' : 'SENT';
        const newOrder: Order = {
          id: generateId('o'),
          orderNumber: generateOrderNumber(input.type, input.tableNumber),
          type: input.type,
          tableNumber: input.tableNumber,
          guestCount: input.guestCount,
          customerName: input.customerName,
          status: initialStatus,
          items,
          messages: [],
          totalAmount,
          createdAt,
          waiterId: input.waiterId,
          waiterName: input.waiterName,
          statusHistory: [{ status: initialStatus, at: createdAt }],
          eventId: input.eventId,
        };

        if (input.orderNote) {
          newOrder.messages.push({
            id: generateId('msg'),
            orderId: newOrder.id,
            senderRole: 'WAITER',
            content: input.orderNote,
            timestamp: new Date().toISOString(),
          });
        }

        state.orders.push(newOrder);
        return newOrder;
      });

      menuService.decrementForItems(input.items);
      return order;
    },

    setStatus(id: string, status: OrderStatus): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        order.status = status;
        if (status === 'DELIVERED') {
          const deliveredAt = new Date().toISOString();
          order.items = order.items.map((it) => (it.deliveredAt ? it : { ...it, deliveredAt }));
        }
        recordStatus(order, status);
        return order;
      });
    },

    setItemStatus(orderId: string, itemId: string, status: OrderStatus): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        const item = order.items.find((it) => it.id === itemId);
        if (!item) throw new OrderError('Article de commande introuvable.', 404);
        item.status = status;

        // Checking off every item never silently advances the order to READY on its own —
        // that transition must go through advanceTicket(), gated by the kitchen checklist.
        const allInPrepOrReady = order.items.every((it) => it.status === 'IN_PREPARATION' || it.status === 'READY');
        if (order.status === 'SENT' && allInPrepOrReady) order.status = 'IN_PREPARATION';
        recordStatus(order, order.status);
        return order;
      });
    },

    advanceTicket(id: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        const next = NEXT_TICKET_STATUS[order.status];
        if (!next) return order;
        order.status = next;
        if (next !== 'DELIVERED') {
          order.items = order.items.map((it) => ({ ...it, status: next }));
        } else {
          const deliveredAt = new Date().toISOString();
          order.items = order.items.map((it) => (it.deliveredAt ? it : { ...it, deliveredAt }));
        }
        recordStatus(order, next);

        // An emporter order paid before the kitchen finished (Caisse step already done) auto-closes
        // the moment it's ready — it just needs to be picked up, no separate encaissement left to do.
        if (next === 'READY' && order.type === 'EPHEMERAL' && order.payment) {
          order.status = 'PAID';
          recordStatus(order, 'PAID');
        }
        return order;
      });
    },

    /**
     * Cashier-time choice: skips the kitchen entirely for an emporter order that doesn't actually need
     * prep (e.g. drinks-only) — decided at the register, at or after payment. Valid for a still-unresolved
     * draft or a not-yet-finished kitchen ticket (DRAFT/SENT/IN_PREPARATION).
     */
    fastTrackToReady(id: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        if (order.type !== 'EPHEMERAL') {
          throw new OrderError('Seules les commandes à emporter peuvent aller directement au comptoir.', 400);
        }
        if (order.status !== 'DRAFT' && order.status !== 'SENT' && order.status !== 'IN_PREPARATION') {
          throw new OrderError('Cette commande a déjà dépassé ce stade.', 400);
        }
        order.isCounterOrder = true;
        order.items = order.items.map((it) => ({ ...it, status: 'READY' }));
        // Always records SENT first so the "Envoyée" stepper stage reads as reached even when this
        // jumped straight from DRAFT — recordStatus no-ops if it's already the last history entry.
        recordStatus(order, 'SENT');
        recordStatus(order, 'IN_PREPARATION');
        order.status = 'READY';
        recordStatus(order, 'READY');
        return order;
      });
    },

    /** Cashier-time choice: confirms a draft emporter order into the real kitchen queue. No-op if already sent. */
    confirmDraftToKitchen(id: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        if (order.type !== 'EPHEMERAL') {
          throw new OrderError('Seules les commandes à emporter sont concernées.', 400);
        }
        if (order.status === 'DRAFT') {
          order.status = 'SENT';
          recordStatus(order, 'SENT');
        }
        return order;
      });
    },

    pay(id: string, method: PaymentMethod, paidAmount: number, split: boolean): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        order.payment = { method, paidAmount, paidAt: new Date().toISOString(), split };
        // Emporter orders can be paid up front, before the kitchen has started/finished — in that
        // case the order stays SENT/IN_PREPARATION so it keeps flowing through the kitchen normally,
        // and only closes out (status PAID) once actually ready (see advanceTicket above).
        const alreadyReady = order.status === 'READY' || order.status === 'DELIVERED';
        if (alreadyReady) {
          order.status = 'PAID';
          recordStatus(order, 'PAID');
        }
        return order;
      });
    },

    /** Marks a paid emporter order as physically handed over at the Comptoir — the last step of that flow. */
    pickup(id: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        if (order.type !== 'EPHEMERAL') throw new OrderError("Cette commande ne fait pas partie du flux comptoir.", 400);
        if (order.status !== 'PAID') throw new OrderError('La commande doit être payée avant la récupération.', 400);
        if (order.pickedUpAt) throw new OrderError('Commande déjà récupérée.', 400);
        order.pickedUpAt = new Date().toISOString();
        return order;
      });
    },

    cancel(id: string, reason?: string, cancelledBy?: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === id);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        order.status = 'CANCELLED';
        order.cancelReason = reason?.trim() || undefined;
        order.cancelledBy = cancelledBy;
        recordStatus(order, 'CANCELLED');
        return order;
      });
    },

    /** Adds items to a still-open TABLE order — e.g. the waiter takes a second round at the same table. */
    addItems(orderId: string, items: NewOrderItemInput[]): Order {
      const order = db.mutate((state) => {
        const target = state.orders.find((o) => o.id === orderId);
        if (!target) throw new OrderError('Commande introuvable.', 404);
        if (target.type !== 'TABLE') {
          throw new OrderError("Seules les commandes sur table peuvent être complétées après l'envoi.", 400);
        }
        if (target.status === 'PAID' || target.status === 'CANCELLED') {
          throw new OrderError('Cette commande est clôturée et ne peut plus être modifiée.', 400);
        }

        const newItems: OrderItem[] = items.map((i) => {
          const menuItem = state.menu.find((m) => m.id === i.menuItemId);
          if (!menuItem) throw new OrderError(`Article introuvable: ${i.menuItemId}`, 400);
          return {
            id: generateId('i'),
            menuItemId: i.menuItemId,
            name: menuItem.name,
            quantity: i.quantity,
            unitPrice: menuItem.price,
            options: i.options,
            kitchenNote: i.kitchenNote,
            status: 'SENT' as OrderStatus,
          };
        });

        target.items.push(...newItems);
        target.totalAmount = target.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

        const allReady = target.items.every((it) => it.status === 'READY');
        const allInPrepOrReady = target.items.every((it) => it.status === 'IN_PREPARATION' || it.status === 'READY');
        target.status = allReady ? 'READY' : allInPrepOrReady ? 'IN_PREPARATION' : 'SENT';
        recordStatus(target, target.status);

        return target;
      });

      menuService.decrementForItems(items);
      return order;
    },

    /** Removes an item that hasn't started preparation yet; restores its stock. */
    removeItem(orderId: string, itemId: string): Order {
      const removed = db.mutate((state) => {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        if (order.type !== 'TABLE') {
          throw new OrderError('Seules les commandes sur table peuvent être modifiées.', 400);
        }
        if (order.status === 'PAID' || order.status === 'CANCELLED') {
          throw new OrderError('Cette commande est clôturée et ne peut plus être modifiée.', 400);
        }
        const item = order.items.find((it) => it.id === itemId);
        if (!item) throw new OrderError('Article de commande introuvable.', 404);
        if (item.status !== 'SENT') {
          throw new OrderError('Cet article est déjà en préparation et ne peut plus être retiré.', 400);
        }
        if (order.items.length <= 1) {
          throw new OrderError('Impossible de retirer le dernier article — annulez la commande à la place.', 400);
        }

        order.items = order.items.filter((it) => it.id !== itemId);
        order.totalAmount = order.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
        return { order, item };
      });

      menuService.adjustStock(removed.item.menuItemId, removed.item.quantity);
      return removed.order;
    },

    addMessage(
      orderId: string,
      senderRole: 'WAITER' | 'KITCHEN',
      content: string,
      isUrgent: boolean,
    ): { order: Order; message: KitchenMessage; kitchenAlert?: WaiterAlert } {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new OrderError('Commande introuvable.', 404);

        const message: KitchenMessage = {
          id: generateId('msg'),
          orderId,
          senderRole,
          content,
          timestamp: new Date().toISOString(),
          isUrgent,
        };
        order.messages.push(message);

        let kitchenAlert: WaiterAlert | undefined;
        if (senderRole === 'WAITER' && isUrgent) {
          kitchenAlert = {
            id: generateId('al'),
            orderId,
            orderLabel: orderLabel(order),
            message: content,
            timestamp: new Date().toISOString(),
          };
          state.kitchenAlerts.unshift(kitchenAlert);
        }

        return { order, message, kitchenAlert };
      });
    },

    alertWaiter(orderId: string, message: string): WaiterAlert {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        const alert: WaiterAlert = {
          id: generateId('al'),
          orderId,
          orderLabel: orderLabel(order),
          message,
          timestamp: new Date().toISOString(),
          targetUserId: order.waiterId,
        };
        state.waiterAlerts.unshift(alert);
        return alert;
      });
    },

    claim(orderId: string, kitchenStaffId: string, kitchenStaffName: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        if (order.kitchenStaffId && order.kitchenStaffId !== kitchenStaffId) {
          throw new OrderError(`Déjà prise en charge par ${order.kitchenStaffName}.`, 409);
        }
        order.kitchenStaffId = kitchenStaffId;
        order.kitchenStaffName = kitchenStaffName;
        return order;
      });
    },

    release(orderId: string): Order {
      return db.mutate((state) => {
        const order = state.orders.find((o) => o.id === orderId);
        if (!order) throw new OrderError('Commande introuvable.', 404);
        order.kitchenStaffId = undefined;
        order.kitchenStaffName = undefined;
        return order;
      });
    },

    /** Throws if a KITCHEN user tries to act on a ticket claimed by a different cook. */
    assertCanProcess(orderId: string, actingUser: { id: string; role: string }): void {
      if (actingUser.role !== 'KITCHEN') return;
      const order = service.get(orderId);
      if (!order) throw new OrderError('Commande introuvable.', 404);
      if (order.kitchenStaffId && order.kitchenStaffId !== actingUser.id) {
        throw new OrderError(`Cette commande est prise en charge par ${order.kitchenStaffName}.`, 403);
      }
    },

    dismissWaiterAlert(id: string): void {
      db.mutate((state) => {
        state.waiterAlerts = state.waiterAlerts.filter((a) => a.id !== id);
      });
    },

    dismissKitchenAlert(id: string): void {
      db.mutate((state) => {
        state.kitchenAlerts = state.kitchenAlerts.filter((a) => a.id !== id);
      });
    },

    listWaiterAlerts(): WaiterAlert[] {
      return db.data.waiterAlerts;
    },

    listKitchenAlerts(): WaiterAlert[] {
      return db.data.kitchenAlerts;
    },
  };

  return service;
}

export type OrdersService = ReturnType<typeof createOrdersService>;
