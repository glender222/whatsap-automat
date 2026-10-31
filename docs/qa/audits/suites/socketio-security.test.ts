import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.JWT_SECRET ||= 'test-jwt-secret-qa-audit-32-chars-strictly-for-testing';
process.env.DB_PASSWORD ||= 'test-db-password-strictly-mocked';

const rootDir = path.resolve(__dirname, '../../../../');
const backendDir = path.join(rootDir, 'WhatsaapWeb-JS');
const SocketHandler = require(path.join(backendDir, 'src/sockets/socketHandler'));
const { setSocketIo, emitDashboard, emitToRoom } = require(path.join(backendDir, 'src/sockets/socketEmitter'));

describe('QA Security Audit: Socket.IO, Rooms y Seguridad en Tiempo Real (PR-02)', () => {

  describe('1. Auditoría de Vulnerabilidades en SocketHandler (SEC-02, SEC-08)', () => {
    test('HALLAZGO CRÍTICO SEC-02: SocketHandler no valida autenticación en la conexión ni filtra por tenant', () => {
      let connectionHandler: ((socket: any) => void) | null = null;
      const mockIo: any = {
        on: (event: string, handler: any) => {
          if (event === 'connection') {
            connectionHandler = handler;
          }
        },
        use: () => {
          throw new Error('io.use no debería ser llamado porque el baseline no tiene middleware de auth en socket');
        }
      };

      const mockWhatsappService: any = {
        getChats: () => [{ id: 'chat_company_1', name: 'Chat Secreto A' }, { id: 'chat_company_2', name: 'Chat Secreto B' }]
      };

      const handler = new SocketHandler(mockWhatsappService);
      handler.handleConnection(mockIo);

      assert.ok(connectionHandler !== null, 'El handler de conexión debe estar registrado');

      // Simulamos la conexión de un cliente sin token alguno
      const emittedEvents: Record<string, any[]> = {};
      const mockSocket: any = {
        id: 'unauthenticated-socket-xyz',
        emit: (event: string, data: any) => {
          emittedEvents[event] = emittedEvents[event] || [];
          emittedEvents[event].push(data);
        },
        on: () => {}
      };

      connectionHandler!(mockSocket);

      // Verificamos que inmediatamente filtra chats de TODAS las empresas
      assert.ok(emittedEvents['chats-updated'], 'Emite chats-updated inmediatamente al conectarse');
      assert.equal(
        emittedEvents['chats-updated'][0].length,
        2,
        'VULNERABILIDAD: Emite todos los chats globales sin verificar token ni companyId'
      );
    });

    test('HALLAZGO CRÍTICO SEC-02: Cliente puede unirse a cualquier room de chatId ajeno sin restricción', async () => {
      const socketListeners: Record<string, (arg?: any) => Promise<void> | void> = {};
      const joinedRooms: string[] = [];

      const mockIo: any = {
        on: (event: string, handler: any) => {
          if (event === 'connection') {
            handler({
              id: 'socket-tenant-a',
              emit: () => {},
              on: (ev: string, fn: any) => { socketListeners[ev] = fn; },
              join: (room: string) => { joinedRooms.push(room); }
            });
          }
        }
      };

      let markAsReadChatId: string | null = null;
      const mockWhatsappService: any = {
        getChats: () => [],
        markAsRead: async (chatId: string) => { markAsReadChatId = chatId; }
      };

      const handler = new SocketHandler(mockWhatsappService);
      handler.handleConnection(mockIo);

      assert.ok(socketListeners['join'], 'Existe listener join');

      // Cliente del Tenant A intenta unirse al chat privado del Tenant B
      await socketListeners['join']('5491199999999@c.us');

      assert.equal(joinedRooms.length, 1);
      assert.equal(
        joinedRooms[0],
        '5491199999999@c.us',
        'VULNERABILIDAD: El socket se une al room del chat ajeno sin comprobar pertenencia a la empresa'
      );
      assert.equal(markAsReadChatId, '5491199999999@c.us', 'Dispara marcado como leído en el chat ajeno');
    });

    test('HALLAZGO CRÍTICO SEC-08: Cliente sin permisos puede forzar logout global de WhatsApp vía socket', async () => {
      const socketListeners: Record<string, (arg?: any) => Promise<void> | void> = {};
      const emittedToSocket: Record<string, any[]> = {};

      const mockIo: any = {
        on: (event: string, handler: any) => {
          if (event === 'connection') {
            handler({
              id: 'malicious-socket',
              emit: (ev: string, data: any) => {
                emittedToSocket[ev] = emittedToSocket[ev] || [];
                emittedToSocket[ev].push(data);
              },
              on: (ev: string, fn: any) => { socketListeners[ev] = fn; }
            });
          }
        }
      };

      let logoutCalled = false;
      const mockWhatsappService: any = {
        getChats: () => [],
        logout: async () => { logoutCalled = true; }
      };

      const handler = new SocketHandler(mockWhatsappService);
      handler.handleConnection(mockIo);

      assert.ok(socketListeners['logout'], 'Existe listener logout');

      // El atacante emite logout
      await socketListeners['logout']();

      assert.equal(logoutCalled, true, 'VULNERABILIDAD SEC-08: whatsappService.logout() fue llamado sin autorización');
      assert.deepEqual(emittedToSocket['logout-confirmed'], [{ success: true }]);
    });
  });

  describe('2. Auditoría de Broadcasts en socketEmitter.ts (SEC-02)', () => {
    test('HALLAZGO CRÍTICO SEC-02: emitDashboard transmite por io.emit() global a todos los clientes sin aislamiento de tenant', () => {
      let broadcastEvent: string | null = null;
      let broadcastPayload: any = null;

      const mockIoServer: any = {
        emit: (event: string, payload: any) => {
          broadcastEvent = event;
          broadcastPayload = payload;
        }
      };

      setSocketIo(mockIoServer);

      // Simulamos la emisión de una actualización de pedido o pago sensible para companyId=5
      emitDashboard('order-status-changed', {
        companyId: 5,
        orderId: 1042,
        status: 'confirmed',
        amount: 50000
      });

      assert.equal(broadcastEvent, 'order-status-changed');
      assert.equal(broadcastPayload?.companyId, 5);
      assert.equal(
        broadcastPayload?.orderId,
        1042,
        'VULNERABILIDAD: Todos los sockets conectados reciben el evento privado de la empresa 5'
      );
    });

    test('emitToRoom no incluye namespace de empresa en la sala (usa chatId plano)', () => {
      let roomTarget: string | null = null;
      let roomEvent: string | null = null;

      const mockIoServer: any = {
        to: (room: string) => {
          roomTarget = room;
          return {
            emit: (ev: string, data: any) => {
              roomEvent = ev;
            }
          };
        }
      };

      setSocketIo(mockIoServer);

      emitToRoom('5491112345678@c.us', 'agent:typing', { chatId: '5491112345678@c.us', agentId: 3 });

      assert.equal(roomTarget, '5491112345678@c.us');
      assert.equal(roomEvent, 'agent:typing');
      assert.ok(!roomTarget?.includes(':'), 'No utiliza formato de sala con scope de tenant tipo company_{id}:chat_{id}');
    });
  });
});
