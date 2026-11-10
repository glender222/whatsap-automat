import { io, type Socket } from 'socket.io-client';
import { invalidateSession, readSession, subscribeSession } from '../shared/auth/session';
import { api, renewAccess, type AuthRequestConfig } from '../shared/axios/http';

const RECONNECTED_STABILITY_MS = 5000;
const SOCKET_URL = (api.defaults.baseURL || 'http://localhost:3000/api').replace(/\/api\/?$/, '');

interface Connection {
  socket: Socket;
  generation: number;
  handshakeToken: string | null;
  rooms: Set<string>;
  blocked: boolean;
  recoveryAttempted: boolean;
  connectedAt: number | null;
}

class SocketService {
  private connection: Connection | null = null;
  private static instance: SocketService;

  private constructor() {
    subscribeSession(() => {
      if (this.connection && this.connection.generation !== readSession().generation) this.disconnect();
    });
  }

  public static getInstance(): SocketService {
    return SocketService.instance ??= new SocketService();
  }

  public connect(): Socket {
    const session = readSession();
    if (this.connection && this.connection.generation !== session.generation) this.disconnect();
    const connection = this.connection ??= this.createConnection(session.generation);
    if (session.accessToken && !connection.socket.active && !connection.blocked) connection.socket.connect();
    return connection.socket;
  }

  private createConnection(generation: number): Connection {
    const socket = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: (send) => {
        const current = this.currentSession(connection);
        if (!current) {
          socket.disconnect();
          return;
        }
        connection.handshakeToken = current.accessToken;
        send({ token: current.accessToken });
      },
    });
    const connection: Connection = {
      socket, generation, handshakeToken: null, rooms: new Set(),
      blocked: false, recoveryAttempted: false, connectedAt: null,
    };
    socket.on('connect', () => {
      if (!this.currentSession(connection)) {
        socket.disconnect();
        return;
      }
      connection.connectedAt = Date.now();
      for (const chatId of connection.rooms) socket.emit('join', chatId);
    });
    socket.on('auth:invalidated', (notice: { reason?: unknown } | null) => {
      if (!this.currentSession(connection)) return;
      if (notice?.reason === 'revoked') invalidateSession(connection.generation);
      if (notice?.reason === 'expiry') void this.recover(connection, 'expiry');
    });
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') void this.recover(connection, 'silent');
    });
    socket.on('connect_error', (error) => {
      if (!this.currentSession(connection)) return;
      const { data } = error as Error & { data?: { code?: unknown; status?: unknown; details?: unknown } };
      if (data?.code === 'SESSION_REVOKED') {
        invalidateSession(connection.generation);
      } else if (data?.code === 'ACCESS_TOKEN_EXPIRED' ||
        (data?.code === 'UNAUTHORIZED' && data?.status === 401 && data?.details === 'jwt expired')) {
        void this.recover(connection, 'expiry');
      } else if (!socket.active) {
        connection.blocked = true;
      }
    });
    return connection;
  }

  private currentSession(connection: Connection) {
    const current = readSession();
    return this.connection === connection && current.generation === connection.generation && current.accessToken
      ? current : null;
  }

  private async recover(connection: Connection, reason: 'expiry' | 'silent') {
    const session = this.currentSession(connection);
    if (!session) return;
    const stable = connection.connectedAt !== null && Date.now() - connection.connectedAt >= RECONNECTED_STABILITY_MS;
    const canRecover = !connection.recoveryAttempted || stable;
    connection.blocked = true;
    connection.connectedAt = null;
    connection.socket.disconnect();
    if (!canRecover) return;
    connection.recoveryAttempted = true;

    try {
      if (reason === 'expiry') {
        await renewAccess({ ...session, accessToken: connection.handshakeToken ?? session.accessToken });
      } else {
        const options: AuthRequestConfig = { sessionGeneration: session.generation, headers: { 'Cache-Control': 'no-cache' } };
        const { data } = await api.get('/auth/me', options);
        if (data?.success !== true || !data.data) return;
      }
      if (!this.currentSession(connection)) return;
      connection.blocked = false;
      connection.socket.connect();
    } catch {
      // The HTTP session flow handles a definitive revocation. Other failures leave realtime offline.
    }
  }

  public disconnect(): void {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    connection.handshakeToken = null;
    connection.rooms.clear();
    connection.socket.auth = {};
    connection.socket.disconnect();
  }

  public getSocket(): Socket | null {
    const connection = this.connection;
    return connection && this.currentSession(connection) ? connection.socket : null;
  }

  public joinRoom(chatId: string, expectedSocket?: Socket): void {
    const connection = this.connection;
    if (!connection || (expectedSocket && connection.socket !== expectedSocket) ||
        !this.currentSession(connection) || connection.rooms.has(chatId)) return;
    connection.rooms.add(chatId);
    if (connection.socket.connected) connection.socket.emit('join', chatId);
  }

  public leaveRoom(chatId: string, expectedSocket?: Socket): void {
    const connection = this.connection;
    if (!connection || (expectedSocket && connection.socket !== expectedSocket) ||
        !this.currentSession(connection) || !connection.rooms.delete(chatId)) return;
    if (connection.socket.connected) connection.socket.emit('leave', chatId);
  }
}

export default SocketService;
