import fs from 'node:fs';
import path from 'node:path';
import { PlatformDocStore } from './platform-doc-store';
import { generateId } from '../utils/id';

export interface ContactMessage {
  id: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  etablissementIdAttempt?: string;
  etablissementName?: string;
  createdAt: string;
  read: boolean;
}

export interface CreateContactMessageInput {
  name: string;
  email: string;
  phone: string;
  message: string;
  etablissementIdAttempt?: string;
  etablissementName?: string;
}

interface ContactMessagesShape {
  messages: ContactMessage[];
}

const CONTACT_MESSAGES_PATH = path.resolve(__dirname, '..', '..', 'data', 'contact-messages.json');

let store: PlatformDocStore<ContactMessagesShape> | undefined;

/** Migrates any pre-existing local contact-messages.json into the platform's Firestore project on first boot. Must resolve before any other export here is called. */
export async function initContactMessagesStore(): Promise<void> {
  store = await PlatformDocStore.create<ContactMessagesShape>('contact-messages', () => {
    if (fs.existsSync(CONTACT_MESSAGES_PATH)) {
      return JSON.parse(fs.readFileSync(CONTACT_MESSAGES_PATH, 'utf-8')) as ContactMessagesShape;
    }
    return { messages: [] };
  });
  if (fs.existsSync(CONTACT_MESSAGES_PATH)) {
    fs.renameSync(CONTACT_MESSAGES_PATH, `${CONTACT_MESSAGES_PATH}.migrated`);
  }
}

function load(): ContactMessagesShape {
  if (!store) throw new Error('Contact messages store not initialized — call initContactMessagesStore() at server boot.');
  return store.data;
}

function save(_data: ContactMessagesShape): void {
  store!.touch();
}

export const contactMessages = {
  list(): ContactMessage[] {
    return load().messages.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  unreadCount(): number {
    return load().messages.filter((m) => !m.read).length;
  },

  create(input: CreateContactMessageInput): ContactMessage {
    const data = load();
    const message: ContactMessage = {
      id: generateId('cm'),
      name: input.name.trim(),
      email: input.email.trim(),
      phone: input.phone.trim(),
      message: input.message.trim(),
      etablissementIdAttempt: input.etablissementIdAttempt?.trim().toUpperCase() || undefined,
      etablissementName: input.etablissementName?.trim() || undefined,
      createdAt: new Date().toISOString(),
      read: false,
    };
    data.messages.push(message);
    save(data);
    return message;
  },

  setRead(id: string, read: boolean): ContactMessage | undefined {
    const data = load();
    const message = data.messages.find((m) => m.id === id);
    if (!message) return undefined;
    message.read = read;
    save(data);
    return message;
  },
};
