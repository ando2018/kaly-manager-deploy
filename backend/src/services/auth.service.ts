import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { IEtablissementDatabase } from '../data/db';
import { config } from '../config';
import { PublicUser, User, UserRole } from '../models/types';

export interface TokenPayload {
  sub: string;
  name: string;
  role: UserRole;
  etablissementId: string;
}

export function toPublicUser(user: User): PublicUser {
  const { pinHash, ...rest } = user;
  return rest;
}

/** Decodes/verifies a token without needing any particular établissement's database. */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}

export function createAuthService(db: IEtablissementDatabase, etablissementId: string) {
  return {
    listPublicProfiles(): PublicUser[] {
      return db.data.users.map(toPublicUser);
    },

    login(
      userId: string,
      pinCode: string,
    ): { user: PublicUser; token: string } | { error: 'invalid' | 'suspended' } {
      const user = db.data.users.find((u) => u.id === userId);
      if (!user) return { error: 'invalid' };
      if (user.suspended) return { error: 'suspended' };
      if (!bcrypt.compareSync(pinCode, user.pinHash)) return { error: 'invalid' };

      const payload: TokenPayload = { sub: user.id, name: user.name, role: user.role, etablissementId };
      const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '12h' });
      return { user: toPublicUser(user), token };
    },

    getPublicUser(userId: string): PublicUser | null {
      const user = db.data.users.find((u) => u.id === userId);
      return user ? toPublicUser(user) : null;
    },

    toPublicUser,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
