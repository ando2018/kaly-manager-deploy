import fs from 'node:fs';
import path from 'node:path';
import { PlatformDocStore } from './platform-doc-store';

export type SubscriptionPlan = 'WEEK' | 'MONTH' | 'YEAR';

export const PLAN_DAYS: Record<SubscriptionPlan, number> = {
  WEEK: 7,
  MONTH: 30,
  YEAR: 365,
};

export const TRIAL_DAYS = 7;

export interface SubscriptionPricing {
  WEEK: number;
  MONTH: number;
  YEAR: number;
}

export interface SubscriptionToken {
  code: string;
  plan: SubscriptionPlan;
  createdAt: string;
  paid: boolean;
  note?: string;
  usedAt?: string;
  usedByEtablissementId?: string;
  revoked?: boolean;
}

interface PricingShape {
  pricing: SubscriptionPricing;
}

interface TokensShape {
  tokens: SubscriptionToken[];
}

const PRICING_PATH = path.resolve(__dirname, '..', '..', 'data', 'subscription-pricing.json');
const TOKENS_PATH = path.resolve(__dirname, '..', '..', 'data', 'subscription-tokens.json');
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

let pricingStore: PlatformDocStore<PricingShape> | undefined;
let tokensStore: PlatformDocStore<TokensShape> | undefined;

/** Migrates any pre-existing local pricing/tokens JSON into the platform's Firestore project on first boot. Must resolve before any other export here is called. */
export async function initSubscriptionsStore(): Promise<void> {
  pricingStore = await PlatformDocStore.create<PricingShape>('subscription-pricing', () => {
    if (fs.existsSync(PRICING_PATH)) return JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8')) as PricingShape;
    return { pricing: { WEEK: 5, MONTH: 15, YEAR: 120 } };
  });
  if (fs.existsSync(PRICING_PATH)) fs.renameSync(PRICING_PATH, `${PRICING_PATH}.migrated`);

  tokensStore = await PlatformDocStore.create<TokensShape>('subscription-tokens', () => {
    if (fs.existsSync(TOKENS_PATH)) return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as TokensShape;
    return { tokens: [] };
  });
  if (fs.existsSync(TOKENS_PATH)) fs.renameSync(TOKENS_PATH, `${TOKENS_PATH}.migrated`);
}

function loadPricing(): PricingShape {
  if (!pricingStore) throw new Error('Subscriptions store not initialized — call initSubscriptionsStore() at server boot.');
  return pricingStore.data;
}

function savePricing(_data: PricingShape): void {
  pricingStore!.touch();
}

function loadTokens(): TokensShape {
  if (!tokensStore) throw new Error('Subscriptions store not initialized — call initSubscriptionsStore() at server boot.');
  return tokensStore.data;
}

function saveTokens(_data: TokensShape): void {
  tokensStore!.touch();
}

function randomGroup(length: number): string {
  return Array.from({ length }, () => TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)]).join('');
}

/** Format: "TOK-XYWE-FF32-PPZ1" — visually distinct from établissement ids (no "TOK-" prefix on those). */
function generateTokenCode(existing: Set<string>): string {
  let code: string;
  do {
    code = `TOK-${Array.from({ length: 3 }, () => randomGroup(4)).join('-')}`;
  } while (existing.has(code));
  return code;
}

export const subscriptions = {
  getPricing(): SubscriptionPricing {
    return loadPricing().pricing;
  },

  setPricing(pricing: SubscriptionPricing): SubscriptionPricing {
    const data = loadPricing();
    data.pricing = pricing;
    savePricing(data);
    return data.pricing;
  },

  listTokens(): SubscriptionToken[] {
    return loadTokens().tokens.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  /** Generates `count` fresh, unused tokens for one plan. */
  generateTokens(plan: SubscriptionPlan, count: number, paid: boolean, note?: string): SubscriptionToken[] {
    const data = loadTokens();
    const existing = new Set(data.tokens.map((t) => t.code));
    const created: SubscriptionToken[] = [];
    for (let i = 0; i < count; i++) {
      const token: SubscriptionToken = {
        code: generateTokenCode(existing),
        plan,
        createdAt: new Date().toISOString(),
        paid,
        note: note?.trim() || undefined,
      };
      existing.add(token.code);
      data.tokens.push(token);
      created.push(token);
    }
    saveTokens(data);
    return created;
  },

  /** Refused for a used or revoked token — caller (platform.ts) applies the actual subscription extension. */
  redeemToken(code: string, etablissementId: string): SubscriptionToken {
    const data = loadTokens();
    const normalized = code.trim().toUpperCase();
    const token = data.tokens.find((t) => t.code === normalized);
    if (!token) throw new Error('Token introuvable.');
    if (token.revoked) throw new Error('Ce token a été révoqué.');
    if (token.usedAt) throw new Error('Ce token a déjà été utilisé.');
    token.usedAt = new Date().toISOString();
    token.usedByEtablissementId = etablissementId;
    saveTokens(data);
    return token;
  },

  /** Refused once a token has been redeemed — only unused tokens can be pulled back out of circulation. */
  revokeToken(code: string): void {
    const data = loadTokens();
    const token = data.tokens.find((t) => t.code === code);
    if (!token) throw new Error('Token introuvable.');
    if (token.usedAt) throw new Error('Impossible de révoquer un token déjà utilisé.');
    token.revoked = true;
    saveTokens(data);
  },
};
