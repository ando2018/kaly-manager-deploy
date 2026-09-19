import { IEtablissementDatabase } from '../data/db';
import { EventStatus, RestaurantEvent } from '../models/types';
import { generateId } from '../utils/id';

export interface NewEventInput {
  name: string;
  description?: string;
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
}

export class EventError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function createEventsService(db: IEtablissementDatabase) {
  return {
    EventError,

    list(): RestaurantEvent[] {
      return db.data.events;
    },

    get(id: string): RestaurantEvent | undefined {
      return db.data.events.find((e) => e.id === id);
    },

    create(input: NewEventInput, createdBy?: string): RestaurantEvent {
      const name = input.name?.trim();
      if (!name) throw new EventError("Le nom de l'évènement est requis.", 400);

      const event: RestaurantEvent = {
        id: generateId('ev'),
        name,
        description: input.description?.trim() || undefined,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        createdBy,
        assignedUserIds: [],
      };

      return db.mutate((state) => {
        state.events.push(event);
        return event;
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
        return event;
      });
    },

    setStatus(id: string, status: EventStatus): RestaurantEvent {
      return db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        event.status = status;
        return event;
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
        return event;
      });
    },

    removeMember(id: string, userId: string): RestaurantEvent {
      return db.mutate((state) => {
        const event = state.events.find((e) => e.id === id);
        if (!event) throw new EventError('Évènement introuvable.', 404);
        event.assignedUserIds = event.assignedUserIds.filter((uid) => uid !== userId);
        return event;
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
