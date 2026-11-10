import type { Notification, Pool, PoolClient } from 'pg';
import type { Socket } from 'socket.io';
import { AccessSession, isActiveAccessSession } from '../services/auth/AccessSession';

type Reason = 'expiry' | 'revoked';
type Subscription = { socket: Socket; invalidated?: Reason | 'unavailable' };
const channel = 'auth_session_revoked';

function disconnect(socket: Socket, reason?: Reason): void {
  if (reason) socket.emit('auth:invalidated', { reason });
  socket.disconnect(true);
}

export class SocketSessionMonitor {
  private listener?: PoolClient;
  private connecting?: Promise<PoolClient>;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private readonly bySocket = new WeakMap<Socket, Subscription>();

  constructor(private readonly pool: Pool) {}

  async admit(socket: Socket, session: AccessSession): Promise<boolean> {
    const listener = await this.ensureListener();
    if (this.listener !== listener) throw new Error('Session listener unavailable');
    const subscription: Subscription = { socket };
    const watchers = this.subscriptions.get(session.sessionId) ?? new Set<Subscription>();
    watchers.add(subscription);
    this.subscriptions.set(session.sessionId, watchers);
    this.bySocket.set(socket, subscription);
    const remove = () => {
      watchers.delete(subscription);
      if (!watchers.size && this.subscriptions.get(session.sessionId) === watchers) this.subscriptions.delete(session.sessionId);
      socket.conn.off('close', remove);
      socket.off('disconnect', remove);
    };
    socket.conn.once('close', remove);
    socket.once('disconnect', remove);
    try {
      const active = await isActiveAccessSession(session);
      if (subscription.invalidated === 'unavailable') throw new Error('Session listener unavailable');
      if (active && !subscription.invalidated && socket.conn.readyState !== 'closed') return true;
      remove();
      return false;
    } catch (error) {
      remove();
      throw error;
    }
  }

  activate(socket: Socket, expiresAt?: number): boolean {
    const invalidated = this.bySocket.get(socket)?.invalidated;
    if (invalidated) {
      disconnect(socket, invalidated === 'revoked' ? 'revoked' : undefined);
      return false;
    }
    if (expiresAt === undefined) return true;
    if (expiresAt <= Date.now()) {
      disconnect(socket, 'expiry');
      return false;
    }
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) disconnect(socket, 'expiry');
      else timer = setTimeout(schedule, Math.min(remaining, 2147483647)).unref();
    };
    schedule();
    socket.once('disconnect', () => clearTimeout(timer));
    socket.use((_packet, next) => {
      if (expiresAt <= Date.now()) disconnect(socket, 'expiry');
      else next();
    });
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.listener) this.dropListener(this.listener);
  }

  private ensureListener(): Promise<PoolClient> {
    if (this.closed) return Promise.reject(new Error('Session listener closed'));
    if (this.listener) return Promise.resolve(this.listener);
    this.connecting ??= this.openListener().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async openListener(): Promise<PoolClient> {
    const client = await this.pool.connect();
    let lost = false;
    const onLost = () => {
      lost = true;
      this.dropListener(client);
    };
    client.on('error', onLost);
    client.once('end', onLost);
    client.on('notification', (message: Notification) => {
      if (this.listener !== client || message.channel !== channel || !message.payload) return;
      for (const subscription of this.subscriptions.get(message.payload) ?? []) {
        subscription.invalidated = 'revoked';
        if (subscription.socket.connected) disconnect(subscription.socket, 'revoked');
      }
    });
    try {
      const installed = { text: `SELECT EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'refresh_tokens'::regclass AND tgname = 'refresh_token_revocation_notification'
          AND tgenabled IN ('O', 'A')) AS enabled`, query_timeout: 2000 };
      const { rows: [trigger] } = await client.query(installed);
      if (!trigger?.enabled) throw new Error('Session revocation migration is required');
      const label = { text: "SET application_name = 'whatsap-session-monitor'", query_timeout: 2000 };
      await client.query(label);
      const listen = { text: `LISTEN ${channel}`, query_timeout: 2000 };
      await client.query(listen);
      if (this.closed || lost) throw new Error('Session listener unavailable');
      this.listener = client;
      this.heartbeat = setInterval(() => {
        const ping = { text: 'SELECT 1', query_timeout: 2000 };
        void client.query(ping).catch(onLost);
      }, 5000).unref();
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  private dropListener(client: PoolClient): void {
    if (this.listener !== client) return;
    this.listener = undefined;
    clearInterval(this.heartbeat);
    for (const watchers of this.subscriptions.values()) {
      for (const subscription of watchers) {
        subscription.invalidated = 'unavailable';
        if (subscription.socket.connected) disconnect(subscription.socket);
      }
    }
    this.subscriptions.clear();
    client.release(true);
  }
}
