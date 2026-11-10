import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

// 1. Invariantes de entorno de prueba antes de cargar configuración
process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD ||= 'test-only-database-password';

const { SocketHandler } = require('../sockets/socketHandler') as typeof import('../sockets/socketHandler');
const {
  emitDashboard,
  emitToRoom,
  emitToTenant,
  setSocketIo,
} = require('../sockets/socketEmitter') as typeof import('../sockets/socketEmitter');
const {
  createExpiredToken,
  createInvalidCompanyClaimToken,
  createInvalidSignatureToken,
  createNoCompanyClaimToken,
  createSnakeCaseCompanyClaimToken,
  createTenantAToken,
  createTenantBToken,
  createTenantIdClaimToken,
  MALFORMED_TOKEN,
  TEST_JWT_SECRET,
} = require('./fixtures/authFixtures') as typeof import('./fixtures/authFixtures');

interface MockConversation {
  id: number;
  company_id: number;
  external_conversation_id: string;
}

const mockConversations: MockConversation[] = [
  { id: 42, company_id: 1, external_conversation_id: '5491111111111@c.us' },
  { id: 99, company_id: 2, external_conversation_id: '5491199999999@c.us' },
];

const mockDb = {
  query: async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
    // 1. Consulta SQL de tenant directo por ID numérico
    if (sql.includes('WHERE id = $1 AND company_id = $2')) {
      const id = Number(params[0]);
      const companyId = Number(params[1]);
      const match = mockConversations.filter(
        (c) => c.id === id && c.company_id === companyId
      );
      return { rows: match };
    }

    // 2. Consulta SQL de tenant directo por JID externo
    if (sql.includes('WHERE external_conversation_id = ANY($1::varchar[]) AND company_id = $2')) {
      const candidates = (params[0] as string[]) || [];
      const companyId = Number(params[1]);
      const match = mockConversations.filter(
        (c) => candidates.includes(c.external_conversation_id) && c.company_id === companyId
      );
      return { rows: match };
    }

    // 3. Verificación de existencia para cualquier tenant (ID numérico)
    if (sql.includes('WHERE id = $1')) {
      const id = Number(params[0]);
      const match = mockConversations.filter((c) => c.id === id);
      return { rows: match.map((c) => ({ id: c.id, company_id: c.company_id })) };
    }

    // 4. Verificación de existencia para cualquier tenant (JID externo)
    if (sql.includes('WHERE external_conversation_id = ANY($1::varchar[])')) {
      const candidates = (params[0] as string[]) || [];
      const match = mockConversations.filter((c) => candidates.includes(c.external_conversation_id));
      return { rows: match.map((c) => ({ id: c.id, company_id: c.company_id })) };
    }

    return { rows: [] };
  },
};

const markAsReadCalls: { chatId: string; companyId: number }[] = [];
let logoutCallCount = 0;

const mockWhatsappService = {
  getChats: () => [],
  getChatsList: async (companyId: number) => [{ id: `chat-tenant-${companyId}` }],
  markAsRead: async (chatId: string, companyId: number) => {
    markAsReadCalls.push({ chatId, companyId });
  },
  logout: async () => {
    logoutCallCount++;
  },
};

describe('PR-F1-01: Socket.IO Fail-Closed Security & Room Isolation', () => {
  let server: http.Server;
  let io: SocketIOServer;
  let serverUrl: string;
  let handler: InstanceType<typeof SocketHandler>;
  const activeClients: ClientSocket[] = [];

  before(async () => {
    server = http.createServer();
    io = new SocketIOServer(server, { cors: { origin: '*' } });
    setSocketIo(io);

    handler = new SocketHandler(mockWhatsappService, mockDb);
    handler.handleConnection(io);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    for (const client of activeClients) {
      if (client.connected) client.disconnect();
    }
    io.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client?.connected) client.disconnect();
    }
  });

  function createClient(token?: string, options: Record<string, unknown> = {}): ClientSocket {
    const client = ioClient(serverUrl, {
      auth: token !== undefined ? { token } : undefined,
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000,
      forceNew: true,
      ...options,
    });
    activeClients.push(client);
    return client;
  }

  function waitForConnect(client: ClientSocket, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for connect (${timeoutMs}ms)`));
      }, timeoutMs);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function waitForConnectError(client: ClientSocket, timeoutMs = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for connect_error (${timeoutMs}ms)`));
      }, timeoutMs);
      client.once('connect_error', (err) => {
        clearTimeout(timer);
        resolve(err);
      });
      client.once('connect', () => {
        clearTimeout(timer);
        reject(new Error('Unexpected successful connect'));
      });
    });
  }

  describe('1. Handshake Fail-Closed JWT Authentication', () => {
    test('rechaza conexión sin token con AUTHENTICATION_ERROR y status 401', async () => {
      const client = createClient();
      const err = await waitForConnectError(client);
      assert.ok(err.message.includes('AUTHENTICATION_ERROR'));
      assert.equal(err.data?.code, 'UNAUTHORIZED');
      assert.equal(err.data?.status, 401);
      assert.equal(client.connected, false);
    });

    test('rechaza conexión con token malformado', async () => {
      const client = createClient(MALFORMED_TOKEN);
      const err = await waitForConnectError(client);
      assert.ok(err.message.includes('AUTHENTICATION_ERROR'));
      assert.equal(err.data?.code, 'UNAUTHORIZED');
      assert.equal(client.connected, false);
    });

    test('rechaza conexión con token expirado', async () => {
      const expiredToken = createExpiredToken(1);
      const client = createClient(expiredToken);
      const err = await waitForConnectError(client);
      assert.ok(err.message.includes('AUTHENTICATION_ERROR'));
      assert.ok(err.message.includes('jwt expired') || err.data?.details?.includes('expired'));
      assert.equal(err.data?.code, 'ACCESS_TOKEN_EXPIRED');
      assert.equal(client.connected, false);
    });

    test('rechaza conexión con firma inválida', async () => {
      const invalidSigToken = createInvalidSignatureToken(1);
      const client = createClient(invalidSigToken);
      const err = await waitForConnectError(client);
      assert.ok(err.message.includes('AUTHENTICATION_ERROR'));
      assert.ok(err.message.includes('invalid signature') || err.data?.details?.includes('signature'));
      assert.equal(err.data?.code, 'UNAUTHORIZED');
      assert.equal(client.connected, false);
    });

    test('SEC-03: rechaza conexión cuando el token carece de claim de empresa (403 FORBIDDEN)', async () => {
      const noClaimToken = createNoCompanyClaimToken();
      const client = createClient(noClaimToken);
      const err = await waitForConnectError(client);
      assert.ok(err.message.includes('AUTHENTICATION_ERROR'));
      assert.equal(err.data?.code, 'FORBIDDEN');
      assert.equal(err.data?.status, 403);
      assert.equal(client.connected, false);
    });

    test('SEC-03: rechaza conexión cuando claim de empresa es booleano { companyId: true }', async () => {
      const boolClaimToken = createInvalidCompanyClaimToken(true);
      const client = createClient(boolClaimToken);
      const err = await waitForConnectError(client);
      assert.ok(err.message.includes('AUTHENTICATION_ERROR'));
      assert.equal(err.data?.code, 'FORBIDDEN');
      assert.equal(err.data?.status, 403);
      assert.equal(client.connected, false);
    });

    test('SEC-03: rechaza conexión cuando claim de empresa es cero o negativo', async () => {
      const zeroClaimToken = createInvalidCompanyClaimToken(0);
      const clientZero = createClient(zeroClaimToken);
      const errZero = await waitForConnectError(clientZero);
      assert.equal(errZero.data?.code, 'FORBIDDEN');

      const negativeClaimToken = createInvalidCompanyClaimToken(-5);
      const clientNeg = createClient(negativeClaimToken);
      const errNeg = await waitForConnectError(clientNeg);
      assert.equal(errNeg.data?.code, 'FORBIDDEN');
    });

    test('acepta conexión con token JWT válido (Tenant 1)', async () => {
      const validToken = createTenantAToken(1);
      const client = createClient(validToken);
      await waitForConnect(client);
      assert.equal(client.connected, true);
    });

    test('acepta conexión con claim alternativo company_id (snake_case)', async () => {
      const snakeToken = createSnakeCaseCompanyClaimToken(3);
      const client = createClient(snakeToken);
      await waitForConnect(client);
      assert.equal(client.connected, true);
    });

    test('acepta conexión con claim alternativo tenantId (contratos v0.4)', async () => {
      const tenantIdToken = createTenantIdClaimToken(4);
      const client = createClient(tenantIdToken);
      await waitForConnect(client);
      assert.equal(client.connected, true);
    });

    test('acepta token provisto via cabecera Authorization con prefijo Bearer', async () => {
      const validToken = createTenantAToken(1);
      const client = createClient(undefined, {
        extraHeaders: {
          authorization: `Bearer ${validToken}`,
        },
      });
      await waitForConnect(client);
      assert.equal(client.connected, true);
    });
  });

  describe('2. Aislamiento de Salas del Servidor (Server-Enforced Room Joins)', () => {
    test('el servidor auto-asocia el socket a salas autorizadas del tenant y usuario', async () => {
      const validToken = createTenantAToken(1, 'ADMIN', { workspaceId: 10, userId: 101 });
      const client = createClient(validToken);
      await waitForConnect(client);

      const serverSocket = io.sockets.sockets.get(client.id!);
      assert.ok(serverSocket, 'Socket del servidor debe existir');

      assert.equal(serverSocket.data.tenantId, '1');
      assert.equal(serverSocket.data.companyId, 1);
      assert.equal(serverSocket.data.userId, '101');
      assert.equal(serverSocket.data.workspaceId, '10');

      const rooms = serverSocket.rooms;
      assert.ok(rooms.has('tenant:1'), 'Debe estar en room tenant:1');
      assert.ok(rooms.has('workspace:1:10'), 'Debe estar en room workspace:1:10');
      assert.ok(rooms.has('user:1:101'), 'Debe estar en room user:1:101');
      assert.ok(!rooms.has('tenant:2'), 'NO debe estar en room tenant:2');
    });

    test('intento directo de unirse a sala de otro tenant (tenant:2) es rechazado', async () => {
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      const response = await new Promise<any>((resolve) => {
        client.emit('join', 'tenant:2', (res: any) => resolve(res));
      });

      assert.equal(response.success, false);
      assert.equal(response.status, 403);
      assert.equal(response.error, 'CROSS_TENANT_FORBIDDEN');

      const serverSocket = io.sockets.sockets.get(client.id!);
      assert.ok(!serverSocket!.rooms.has('tenant:2'));
    });

    test('no emite lista de chats no acotada al conectarse (chats-updated)', async () => {
      const client = createClient(createTenantAToken(1));
      let receivedChats = false;
      client.on('chats-updated', () => {
        receivedChats = true;
      });
      await waitForConnect(client);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(receivedChats, false, 'No debe emitir chats-updated no acotado al conectar');
    });
  });

  describe('3. Verificación de Conversaciones en BD y Aislamiento Cross-Tenant', () => {
    test('intento de unirse a conversación de otra empresa es rechazado con 403', async () => {
      // Tenant 1 intenta unirse al chat de Tenant 2 ('5491199999999@c.us')
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      const response = await new Promise<any>((resolve) => {
        client.emit('join_conversation', '5491199999999@c.us', (res: any) => resolve(res));
      });

      assert.equal(response.success, false);
      assert.equal(response.status, 403);
      assert.equal(response.error, 'FORBIDDEN');

      const serverSocket = io.sockets.sockets.get(client.id!);
      assert.ok(!serverSocket!.rooms.has('conversation:1:5491199999999@c.us'));
      assert.ok(!serverSocket!.rooms.has('5491199999999@c.us'));
    });

    test('unirse a conversación propia es aceptado y une a la sala acotada', async () => {
      // Tenant 1 se une a su propio chat ('5491111111111@c.us')
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      const response = await new Promise<any>((resolve) => {
        client.emit('join_conversation', '5491111111111@c.us', (res: any) => resolve(res));
      });

      assert.equal(response.success, true);
      assert.equal(response.room, 'conversation:1:5491111111111@c.us');

      const serverSocket = io.sockets.sockets.get(client.id!);
      assert.ok(serverSocket!.rooms.has('conversation:1:5491111111111@c.us'));
      assert.ok(serverSocket!.rooms.has('5491111111111@c.us'));
    });

    test('evento legacy join ejecuta la misma validación de tenant', async () => {
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      // Intento cross-tenant usando evento 'join' legacy
      const crossRes = await new Promise<any>((resolve) => {
        client.emit('join', '5491199999999@c.us', (res: any) => resolve(res));
      });
      assert.equal(crossRes.success, false);
      assert.equal(crossRes.status, 403);

      // Intento propio usando evento 'join' legacy
      const ownRes = await new Promise<any>((resolve) => {
        client.emit('join', '5491111111111@c.us', (res: any) => resolve(res));
      });
      assert.equal(ownRes.success, true);
    });

    test('rechaza formato de chatId inválido con 400 INVALID_CHAT_ID', async () => {
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      const response = await new Promise<any>((resolve) => {
        client.emit('join_conversation', 'chat; DROP TABLE conversations;--', (res: any) => resolve(res));
      });

      assert.equal(response.success, false);
      assert.equal(response.status, 400);
      assert.equal(response.error, 'INVALID_CHAT_ID');
    });

    test('conversación no existente en ningún tenant retorna 404 CHAT_NOT_FOUND', async () => {
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      const response = await new Promise<any>((resolve) => {
        client.emit('join_conversation', '5491100000000@c.us', (res: any) => resolve(res));
      });

      assert.equal(response.success, false);
      assert.equal(response.status, 404);
      assert.equal(response.error, 'CHAT_NOT_FOUND');
    });

    test('leave_conversation remueve el socket de las salas del chat', async () => {
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      await new Promise<any>((resolve) => {
        client.emit('join_conversation', '5491111111111@c.us', (res: any) => resolve(res));
      });

      const serverSocket = io.sockets.sockets.get(client.id!);
      assert.ok(serverSocket!.rooms.has('conversation:1:5491111111111@c.us'));

      client.emit('leave_conversation', '5491111111111@c.us');
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(!serverSocket!.rooms.has('conversation:1:5491111111111@c.us'));
      assert.ok(!serverSocket!.rooms.has('5491111111111@c.us'));
    });
  });

  describe('4. Prevención de Denial of Service (Socket Logout Deshabilitado)', () => {
    test('logout via socket retorna LOGOUT_VIA_SOCKET_DISABLED y preserva sesión de WhatsApp', async () => {
      const client = createClient(createTenantAToken(1));
      await waitForConnect(client);

      const startLogoutCalls = logoutCallCount;

      const callbackResponse = await new Promise<any>((resolve) => {
        client.emit('logout', (res: any) => resolve(res));
      });

      assert.equal(callbackResponse.success, false);
      assert.equal(callbackResponse.error, 'LOGOUT_VIA_SOCKET_DISABLED');
      assert.equal(logoutCallCount, startLogoutCalls, 'whatsappService.logout() no debe ser invocado');
    });
  });

  describe('5. Entrega de Eventos Acotada por Tenant (Zero Global Broadcasts)', () => {
    test('emitToTenant entrega evento solo al tenant destinatario y no a otros tenants', async () => {
      const clientA = createClient(createTenantAToken(1));
      const clientB = createClient(createTenantBToken(2));

      await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

      let clientAReceived: any = null;
      let clientBReceived: any = null;

      clientA.on('tenant-event', (data) => {
        clientAReceived = data;
      });
      clientB.on('tenant-event', (data) => {
        clientBReceived = data;
      });

      emitToTenant(1, 'tenant-event', { secret: 'tenant-1-only', companyId: 1 });

      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.ok(clientAReceived, 'Cliente A (Tenant 1) debe recibir el evento');
      assert.equal(clientAReceived.secret, 'tenant-1-only');
      assert.equal(clientBReceived, null, 'Cliente B (Tenant 2) NO debe recibir el evento de Tenant 1');
    });

    test('emitDashboard enruta hacia la sala del tenant extrayendo claim companyId del payload', async () => {
      const clientA = createClient(createTenantAToken(1));
      const clientB = createClient(createTenantBToken(2));

      await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

      let clientBPayload: any = null;
      let clientAPayload: any = null;

      clientA.on('payment-created', (p) => {
        clientAPayload = p;
      });
      clientB.on('payment-created', (p) => {
        clientBPayload = p;
      });

      // Emisión de evento para Tenant 2 con companyId en payload
      emitDashboard('payment-created', { companyId: 2, amount: 250 });

      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(clientAPayload, null, 'Tenant 1 no debe recibir evento de pago de Tenant 2');
      assert.ok(clientBPayload, 'Tenant 2 debe recibir su evento de pago');
      assert.equal(clientBPayload.amount, 250);
    });

    test('emitDashboard sin tenant es rechazado fail-closed y produce cero emisiones', async () => {
      const clientA = createClient(createTenantAToken(1));
      const clientB = createClient(createTenantBToken(2));

      await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

      let anyReceived = false;
      const listener = () => {
        anyReceived = true;
      };

      clientA.on('orphan-event', listener);
      clientB.on('orphan-event', listener);

      // Intento de emitir evento global sin tenantId en payload ni parámetros
      emitDashboard('orphan-event', { data: 'test-sin-tenant' });

      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(anyReceived, false, 'Emisión sin tenant debe ser descartada fail-closed sin fugas');
    });

    test('emitToRoom entrega eventos solo a los sockets unidos a dicha sala', async () => {
      const clientA = createClient(createTenantAToken(1));
      const clientB = createClient(createTenantBToken(2));

      await Promise.all([waitForConnect(clientA), waitForConnect(clientB)]);

      // Client A se une a sala específica
      await new Promise<any>((resolve) => {
        clientA.emit('join_conversation', '5491111111111@c.us', (res: any) => resolve(res));
      });

      let clientAMsg: any = null;
      let clientBMsg: any = null;

      clientA.on('new-message', (m) => {
        clientAMsg = m;
      });
      clientB.on('new-message', (m) => {
        clientBMsg = m;
      });

      emitToRoom('conversation:1:5491111111111@c.us', 'new-message', { text: 'hola tenant 1' });

      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.ok(clientAMsg, 'Client A debe recibir el mensaje');
      assert.equal(clientBMsg, null, 'Client B no debe recibir el mensaje');
    });
  });

  describe('6. Verificación de Integridad Estática en sockets/', () => {
    test('cero ocurrencias de ioInstance.emit en WhatsaapWeb-JS/src/sockets/', () => {
      const socketsDir = path.resolve(__dirname, '../sockets');
      const files = fs.readdirSync(socketsDir);

      for (const file of files) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const content = fs.readFileSync(path.join(socketsDir, file), 'utf-8');
          const hasUnscoped = content.includes('ioInstance.emit(');
          assert.equal(
            hasUnscoped,
            false,
            `El archivo ${file} contiene llamada no acotada a ioInstance.emit()`
          );
        }
      }
    });

    test('archivo legado socketHandler.js no debe existir en el repositorio', () => {
      const legacyPath = path.resolve(__dirname, '../sockets/socketHandler.js');
      assert.equal(fs.existsSync(legacyPath), false, 'socketHandler.js debe estar eliminado');
    });
  });
});
