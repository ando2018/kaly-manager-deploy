import { IEtablissementDatabase } from '../data/db';
import { EventServiceType, EventStatus, RestaurantEvent } from '../models/types';
import { generateId } from '../utils/id';

export interface NewEventInput {
  name: string;
  description?: string;
  serviceType?: EventServiceType;
  /** STANDARD-only — ignored (never stored) for COUNTER, which has no table service. */
  tableCount?: number;
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
  serviceType?: EventServiceType;
  tableCount?: number;
}

function normalizeTableCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Math.round(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class EventError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** The évènement as exposed to clients — its per-item stock is internal (served through the menu instead). */
function toPublic(event: RestaurantEvent): RestaurantEvent {
  const { eventStock: _stock, ...rest } = event;
  return rest;
}

export function createEventsService(db: IEtablissementDatabase) {
  return {
    EventError,

    list(): RestaurantEvent[] {
      return db.data.events.map(toPublic);
    },

    get(id: string): RestaurantEvent | undefined {
      const event = db.data.events.find((e) => e.id === id);
      return event && toPublic(event);
    },

    create(input: NewEventInput, createdBy?: string): RestaurantEvent {
      const name = input.name?.trim();
      if (!name) throw new EventError("Le nom de l'évènement est requis.", 400);
      const serviceType = input.serviceType === 'COUNTER' ? 'COUNTER' : 'STANDARD';

      const event: RestaurantEvent = {
        id: generateId('ev'),
        name,
        description: input.description?.trim() || undefined,
        status: 'ACTIVE',
        serviceType,
        tableCount: serviceType === 'STANDARD' ? normalizeTableCount(input.tableCount) : undefined,
        createdAt: new Date().toISOString(),
        createdBy,
        assignedUserIds: [],
      };

      return db.mutate((state) => {
        state.events.push(event);
        return toPublic(event);
      });
    },

    update(id: string, input: UpdateEventInput): RestaurantEvent {
      return db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        if (input.name !== undefined) {
          const name = input.name.trim();
          if (!name) throw new EventError("Le nom de l'évènement est requis.", 400);
          event.name = name;
        }
        if (input.description !== undefined) {
          event.description = input.description.trim() || undefined;
        }
        if (input.serviceType !== undefined) {
          event.serviceType = input.serviceType;
        }
        if (input.tableCount !== undefined) {
          event.tableCount = normalizeTableCount(input.tableCount);
        }
        // Counter service skips tables entirely — never leave a stale count behind after switching to it.
        if (event.serviceType === 'COUNTER') {
          event.tableCount = undefined;
        }
        return toPublic(event);
      });
    },

    setStatus(id: string, status: EventStatus): RestaurantEvent {
      return db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        event.status = status;
        return toPublic(event);
      });
    },

    addMember(id: string, userId: string): RestaurantEvent {
      return db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        const user = state.users.find((u) => u.id === userId);
        if (!user) throw new EventError('Utilisateur introuvable.', 404);
        if (!event.assignedUserIds.includes(userId)) {
          event.assignedUserIds.push(userId);
        }
        return toPublic(event);
      });
    },

    removeMember(id: string, userId: string): RestaurantEvent {
      return db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        event.assignedUserIds = event.assignedUserIds.filter((uid) => uid !== userId);
        return toPublic(event);
      });
    },

    remove(id: string): void {
      db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        state.events = state.events.filter((e) => e.id !== id);
      });
    },
  };
}

export type EventsService = ReturnType<typeof createEventsService>;
