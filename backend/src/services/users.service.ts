import bcrypt from 'bcryptjs';
import { IEtablissementDatabase } from '../data/db';
import { PublicUser, User, UserRole } from '../models/types';
import { generateId } from '../utils/id';
import { toPublicUser } from './auth.service';

export interface CreateUserInput {
  name: string;
  role: UserRole;
  pinCode: string;
  mustChangePin: boolean;
}

export interface UpdateUserInput {
  name?: string;
  role?: UserRole;
}

export class UserError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function assertPinFormat(pin: string): void {
  if (!/^\d{4}$/.test(pin)) {
    throw new UserError('Le code PIN doit contenir exactement 4 chiffres.', 400);
  }
}

export function createUsersService(db: IEtablissementDatabase) {
  return {
    UserError,

    list(): PublicUser[] {
      return db.data.users.map(toPublicUser);
    },

    create(input: CreateUserInput): PublicUser {
      const name = input.name?.trim();
      if (!name) throw new UserError('Le nom est requis.', 400);
      assertPinFormat(input.pinCode);

      const user: User = {
        id: generateId('u'),
        name,
        role: input.role,
        pinHash: bcrypt.hashSync(input.pinCode, 8),
        createdAt: new Date().toISOString(),
        mustChangePin: input.mustChangePin,
      };

      return db.mutate((state) => {
        state.users.push(user);
        return toPublicUser(user);
      });
    },

    update(id: string, input: UpdateUserInput): PublicUser {
      return db.mutate((state) => {
        const user = state.users.find((u) => u.id === id);
        if (!user) throw new UserError('Utilisateur introuvable.', 404);
        if (input.name !== undefined) {
          const name = input.name.trim();
          if (!name) throw new UserError('Le nom est requis.', 400);
          user.name = name;
        }
        if (input.role !== undefined) user.role = input.role;
        return toPublicUser(user);
      });
    },

    resetPin(id: string, pinCode: string): PublicUser {
      assertPinFormat(pinCode);
      return db.mutate((state) => {
        const user = state.users.find((u) => u.id === id);
        if (!user) throw new UserError('Utilisateur introuvable.', 404);
        user.pinHash = bcrypt.hashSync(pinCode, 8);
        user.mustChangePin = true;
        return toPublicUser(user);
      });
    },

    /** Self-service PIN change — used when a user acts on the "must change PIN" prompt after a reset. */
    changeOwnPin(id: string, pinCode: string): PublicUser {
      assertPinFormat(pinCode);
      return db.mutate((state) => {
        const user = state.users.find((u) => u.id === id);
        if (!user) throw new UserError('Utilisateur introuvable.', 404);
        user.pinHash = bcrypt.hashSync(pinCode, 8);
        user.mustChangePin = false;
        return toPublicUser(user);
      });
    },

    setSuspended(id: string, requestingUserId: string, suspended: boolean): PublicUser {
      return db.mutate((state) => {
        const user = state.users.find((u) => u.id === id);
        if (!user) throw new UserError('Utilisateur introuvable.', 404);
        if (suspended && id === requestingUserId) {
          throw new UserError('Vous ne pouvez pas suspendre votre propre compte.', 400);
        }
        if (
          suspended &&
          user.role === 'ADMIN' &&
          state.users.filter((u) => u.role === 'ADMIN' && !u.suspended).length <= 1
        ) {
          throw new UserError('Impossible de suspendre le dernier compte administrateur actif.', 400);
        }
        user.suspended = suspended;
        return toPublicUser(user);
      });
    },

    remove(id: string, requestingUserId: string): void {
      db.mutate((state) => {
        const user = state.users.find((u) => u.id === id);
        if (!user) throw new UserError('Utilisateur introuvable.', 404);
        if (id === requestingUserId) {
          throw new UserError('Vous ne pouvez pas supprimer votre propre compte.', 400);
        }
        if (user.role === 'ADMIN' && state.users.filter((u) => u.role === 'ADMIN').length <= 1) {
          throw new UserError('Impossible de supprimer le dernier compte administrateur.', 400);
        }
        state.users = state.users.filter((u) => u.id !== id);
      });
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
