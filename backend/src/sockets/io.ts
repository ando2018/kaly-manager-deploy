import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { ensureEtablissementContext, getEtablissementContext } from '../data/etablissement-registry';
import { platform } from '../data/platform';

let io: SocketIOServer | undefined;

function etablissementIdFromSocket(socket: { handshake: { query: Record<string, unknown> } }): string | undefined {
  const raw = socket.handshake.query.etablissementId;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value ? value.trim().toUpperCase() : undefined;
}

export function initSockets(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });

  io.on('connection', async (socket) => {
    const etablissementId = etablissementIdFromSocket(socket);
    const context = etablissementId ? await ensureEtablissementContext(etablissementId) : undefined;
    if (!context || socket.disconnected) {
      socket.disconnect(true);
      return;
    }

    const meta = platform.findEtablissement(context.id);
    const subscription = platform.subscriptionStatus(context.id);
    if (meta?.archived || (subscription && !subscription.active)) {
      socket.disconnect(true);
      return;
    }

    platform.touchActivity(context.id);
    socket.join(context.id);
    socket.emit('state:menu', context.menu.list());
    socket.emit('state:orders', context.orders.list());
    socket.emit('state:events', context.events.list());
    socket.emit('state:waiterAlerts', context.orders.listWaiterAlerts());
    socket.emit('state:kitchenAlerts', context.orders.listKitchenAlerts());
    socket.emit('state:theme', {
      theme: context.db.data.theme ?? 'emerald',
      customTheme: context.db.data.customTheme,
    });
  });

  return io;
}

export function broadcastMenu(etablissementId: string): void {
  const context = getEtablissementContext(etablissementId);
  if (context) io?.to(etablissementId).emit('state:menu', context.menu.list());
}

export function broadcastOrders(etablissementId: string): void {
  const context = getEtablissementContext(etablissementId);
  if (context) io?.to(etablissementId).emit('state:orders', context.orders.list());
}

export function broadcastAlerts(etablissementId: string): void {
  const context = getEtablissementContext(etablissementId);
  if (!context) return;
  io?.to(etablissementId).emit('state:waiterAlerts', context.orders.listWaiterAlerts());
  io?.to(etablissementId).emit('state:kitchenAlerts', context.orders.listKitchenAlerts());
}

export function broadcastUsers(etablissementId: string): void {
  io?.to(etablissementId).emit('state:usersChanged');
}

export function broadcastEvents(etablissementId: string): void {
  const context = getEtablissementContext(etablissementId);
  if (context) io?.to(etablissementId).emit('state:events', context.events.list());
}

export function broadcastTheme(etablissementId: string, theme: string, customTheme?: unknown): void {
  io?.to(etablissementId).emit('state:theme', { theme, customTheme });
}
