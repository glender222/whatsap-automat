/**
 * Modelos unificados para WhatsApp Web - v1.34.4+
 * 
 * Estos modelos reflejan la estructura exacta que devuelve el backend
 * después de los cambios de compatibilidad con whatsapp-web.js v1.34.4+
 * 
 * IMPORTANTE: Todos los componentes del frontend deben usar estos tipos
 * para garantizar consistencia y facilitar el mantenimiento.
 * 
 * @usage
 * import { WhatsAppChat, WhatsAppMessage, MessageReplacedEvent } from '../types/wsp';
 */

// ============================================================================
// MODELOS DE CHAT
// ============================================================================

/** Información de un chat de WhatsApp */
export interface WhatsAppChat {
  id: string;
  conversationId?: string;
  name: string;
  profilePhotoUrl?: string | null;
  photoUrl?: string | null;
  lastMessageTimestamp: number;
  lastMessagePreview: string | null;
  unreadCount: number;
  isGroup?: boolean;
}

/** Estado de carga de chats */
export interface LoadingChatsState {
  status: 'idle' | 'fetching' | 'processing' | 'initial-loaded' | 'loading' | 'completed' | 'error';
  message?: string;
  loaded?: number;
  total?: number;
  percentage?: number;
}

// ============================================================================
// MODELOS DE MENSAJE
// ============================================================================

/** Información multimedia de un mensaje */
export interface WhatsAppMedia {
  hasMedia: boolean;
  messageId: string;
  type: string;
  mimetype?: string;
  filename?: string;
  mediaUrl: string;
}

/** Estado de un mensaje */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed';

/** Un mensaje de WhatsApp */
export interface WhatsAppMessage {
  id: string;
  historyId?: string;
  status?: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  sender: string;
  type: string;
  hasMedia?: boolean;
  media?: WhatsAppMedia | null;
  mediaUrl?: string;
  mimetype?: string;
  filename?: string;
  fileSize?: number | null;
  unreadCount?: number;
  chatId: string;
  isOptimistic?: boolean;
  uploadError?: boolean | string;
  _pendingReconciliation?: boolean;
  _reconciled?: boolean;
}

export interface FilePreview {
  file: File;
  preview: string;
  type: 'image' | 'video' | 'audio' | 'document';
}

/** Evento de reemplazo de mensaje (para mensajes temporales) */
export interface MessageReplacedEvent {
  tempId: string;
  realMessage: WhatsAppMessage;
}

// ============================================================================
// MODELOS DE PERFIL
// ============================================================================

/** Información de contacto de WhatsApp */
export interface WhatsAppContact {
  id: string;
  name?: string;
  pushname?: string;
  user?: string;
  profilePhotoUrl?: string | null;
}

/** Respuesta de la API de foto de perfil */
export interface ProfilePhotoResponse {
  success: boolean;
  data?: {
    profilePhotoUrl: string | null;
    reason?: string;
  };
  error?: string;
  details?: string;
}

// ============================================================================
// MODELOS DE ESTADO DE CONEXIÓN
// ============================================================================

/** Estado de la conexión de WhatsApp */
export interface WhatsAppConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'qr' | 'failure';
  message?: string;
  hasQR?: boolean;
  reason?: string;
}

/** Evento de Socket */
export interface SocketEventData {
  event: string;
  data?: unknown;
}

// ============================================================================
// UTILIDADES DE TIPO
// ============================================================================

/** Verifica si un mensaje es un mensaje real (no evento de sistema) */
export function isRealMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  
  const m = msg as Record<string, unknown>;
  if (!m.id || typeof m.id !== 'string') return false;
  
  const ts = m.timestamp;
  if (typeof ts !== 'number' || ts <= 0) return false;
  
  const hasBody = typeof m.body === 'string' && m.body.trim().length > 0;
  const hasMedia = m.hasMedia === true;
  
  return hasBody || hasMedia;
}

/** Parsea el timestamp de forma robusta (para uso en frontend si es necesario) */
export function parseTimestamp(ts: unknown): number {
  if (!ts) return 0;
  
  if (typeof ts === 'number') {
    if (ts > 1000 && ts < 20000000000) return ts;
    return 0;
  }
  
  if (typeof ts === 'string') {
    const parsed = parseInt(ts, 10);
    if (!isNaN(parsed) && parsed > 1000 && parsed < 20000000000) return parsed;
    return 0;
  }
  
  if (typeof ts === 'object') {
    const obj = ts as Record<string, unknown>;
    if (obj.seconds) return parseTimestamp(obj.seconds);
    if (obj.low) return parseTimestamp(obj.low);
    if (obj.high) return parseTimestamp(obj.high);
  }
  
  return 0;
}

/** Formatea un timestamp para mostrar (ej: "10:30", "Ayer", etc) */
export function formatMessageTime(timestamp: number): string {
  if (!timestamp || timestamp === 0) return '';
  
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;
  
  if (diffDays === 0) {
    return timeStr;
  } else if (diffDays === 1) {
    return 'Ayer';
  } else if (diffDays < 7) {
    const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    return days[date.getDay()];
  } else {
    return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  }
}

/** Normaliza el timestamp de mensajes del backend (convierte de segundos a ms si es necesario) */
export function normalizeMessageTimestamp(timestamp: number | null | undefined): number {
  if (!timestamp) return 0;
  
  if (timestamp < 1e12) {
    return timestamp * 1000;
  }
  return timestamp;
}

/** Crea un mensaje temporal (optimista) para mostrar mientras se envía */
export function createOptimisticMessage(chatId: string, body: string): WhatsAppMessage {
  return {
    id: `temp-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    body,
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000),
    sender: 'me',
    type: 'chat',
    hasMedia: false,
    media: null,
    chatId,
    _pendingReconciliation: true
  };
}
