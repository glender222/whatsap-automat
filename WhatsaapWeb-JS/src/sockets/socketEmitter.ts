import { Server } from 'socket.io';

let ioInstance: Server | null = null;

export function setSocketIo(io: Server): void {
  ioInstance = io;
}

export function getSocketIo(): Server | null {
  return ioInstance;
}

/**
 * Emite un evento a una sala Socket.IO arbitraria.
 */
export function emitToRoom(room: string, event: string, payload: unknown): void {
  if (!ioInstance) return;
  if (!room || typeof room !== 'string') return;
  try {
    ioInstance.to(room).emit(event, payload);
  } catch (error) {
    console.error(`Error emitiendo evento socket ${event} a room ${room}:`, error);
  }
}

/**
 * Emite un evento acotado estrictamente a una sala de tenant ('tenant:<id>').
 */
export function emitToTenant(tenantId: number | string, event: string, payload: unknown): void {
  if (!ioInstance) return;
  const tid = String(tenantId ?? '').trim();
  if (!tid || tid === '0' || tid === 'null' || tid === 'undefined') {
    console.warn(`[socketEmitter] Intento de emision a tenant invalido: "${tenantId}" para evento "${event}"`);
    return;
  }
  try {
    ioInstance.to(`tenant:${tid}`).emit(event, payload);
  } catch (error) {
    console.error(`Error emitiendo evento socket ${event} a tenant ${tid}:`, error);
  }
}

/**
 * Emite un evento a una sala de conversación acotada ('conversation:<tenantId>:<conversationId>').
 */
export function emitConversation(
  tenantId: number | string,
  conversationId: string,
  event: string,
  payload: unknown
): void {
  if (!ioInstance) return;
  const tid = String(tenantId ?? '').trim();
  const cid = String(conversationId ?? '').trim();
  if (!tid || !cid) return;
  emitToRoom(`conversation:${tid}:${cid}`, event, payload);
}

/**
 * Emite un evento a una sala de usuario acotada ('user:<tenantId>:<userId>').
 */
export function emitUser(
  tenantId: number | string,
  userId: number | string,
  event: string,
  payload: unknown
): void {
  if (!ioInstance) return;
  const tid = String(tenantId ?? '').trim();
  const uid = String(userId ?? '').trim();
  if (!tid || !uid) return;
  emitToRoom(`user:${tid}:${uid}`, event, payload);
}

/**
 * Emite eventos de dashboard exclusivamente acotados por tenant.
 * Soporta sobrecarga:
 * - emitDashboard(tenantId, event, payload)
 * - emitDashboard(event, payload) -> resolviendo companyId/tenantId del payload
 *
 * Si ningún tenant es resoluble, descarta la emisión fail-closed y registra alerta.
 * NUNCA invoca un io.emit global no acotado.
 */
export function emitDashboard(tenantId: number | string, event: string, payload: unknown): void;
export function emitDashboard(event: string, payload: unknown): void;
export function emitDashboard(
  first: number | string,
  second: unknown,
  third?: unknown
): void {
  if (!ioInstance) return;

  let tenantId: string | number | null = null;
  let eventName: string;
  let payload: unknown;

  if (third !== undefined) {
    // Firma: emitDashboard(tenantId, event, payload)
    tenantId = first;
    eventName = String(second);
    payload = third;
  } else {
    // Firma: emitDashboard(event, payload)
    eventName = String(first);
    payload = second;

    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      tenantId =
        (obj.companyId as number | string) ??
        (obj.company_id as number | string) ??
        (obj.tenantId as number | string) ??
        null;
    }
  }

  const tid = String(tenantId ?? '').trim();
  if (!tid || tid === '0' || tid === 'null' || tid === 'undefined') {
    console.error(
      `[socketEmitter] RECHAZADO FAIL-CLOSED: Intento de io.emit no acotado para evento "${eventName}" sin tenantId.`
    );
    return;
  }

  emitToTenant(tid, eventName, payload);
}
