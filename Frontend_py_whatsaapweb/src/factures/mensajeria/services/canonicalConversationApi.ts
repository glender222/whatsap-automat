import { isAxiosError } from 'axios';
import { api, type AuthRequestConfig } from '../../../shared/axios/http';

export interface InboxActor { id: string; tenantId: string }

export interface CanonicalConversation {
  id: string;
  tenantId: string;
  externalConversationId: string;
  channel: string;
  status: string;
  stateVersion: number;
  hasUnresolvedDelivery?: boolean;
  assignedUserId: string | null;
  assignedAgentId: string | null;
  aiPaused: boolean;
  serviceWindowExpiresAt: string | null;
}

export interface CanonicalMessage {
  id: string;
  conversationId: string;
  tenantId: string;
  direction: string;
  deliveryState: string;
  clientRequestId: string | null;
  causedBy?: { type: string };
}

export interface PublishedWhatsappSuggestion {
  runId: string;
  graphId: string;
  version: number;
  specHash: string;
  inboundMessageId: string;
  conversationId: string;
  reply: string;
  expiresAt: string;
}

export async function readPublishedWhatsappSuggestion(conversationId: string, signal: AbortSignal, sessionGeneration: number) {
  const config: AuthRequestConfig = { params: { conversationId }, signal, sessionGeneration };
  const { data } = await api.get<{ suggestion: PublishedWhatsappSuggestion | null }>('/v1/ai/whatsapp-suggestions', config);
  const suggestion = data?.suggestion;
  if (suggestion === null) return null;
  if (!suggestion || suggestion.conversationId !== conversationId ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(suggestion.runId) ||
      !/^[1-9][0-9]{0,18}$/.test(suggestion.inboundMessageId) || !/^[A-Za-z0-9_-]{1,128}$/.test(suggestion.graphId) ||
      !Number.isSafeInteger(suggestion.version) || suggestion.version < 1 || !/^[0-9a-f]{64}$/.test(suggestion.specHash) ||
      typeof suggestion.reply !== 'string' || !suggestion.reply.trim() || !Number.isFinite(Date.parse(suggestion.expiresAt))) {
    throw new Error('El servidor no confirmó la sugerencia para esta conversación.');
  }
  return Date.parse(suggestion.expiresAt) > Date.now() ? suggestion : null;
}

interface SendIntent {
  conversationId: string;
  key: string;
  version: number;
}

export interface TextIntent extends SendIntent {
  text: string;
}

interface AttachmentDraft {
  file: File;
  forceDocument: boolean;
}

export interface AttachmentIntent extends SendIntent, AttachmentDraft {
  caption: string;
}

type SendReceipt = { providerMessageId: string | null; accepted: boolean; deliveryState: string };
type SendOutcome = { kind: 'accepted' | 'failed' | 'unknown'; deliveryState: string };
type MessageProblem = { reason: string; message: string; uncertain: boolean };

const endpoint = (id: string) => `/v1/conversations/${encodeURIComponent(id)}`;
const digits = /^[1-9][0-9]{0,9}$/;

export function inboxActor(user: { id?: unknown; companyId?: unknown; tenantId?: unknown; rol?: unknown } | null): InboxActor | null {
  const id = String(user?.id ?? '');
  const tenantId = String(user?.companyId ?? user?.tenantId ?? '');
  if (!digits.test(id) || !digits.test(tenantId) ||
      !['ADMIN', 'EMPLEADO', 'SUPERADMIN'].includes(String(user?.rol))) return null;
  return { id, tenantId };
}

function isSameChat(external: string, legacy: string) {
  return external === legacy || external === legacy.replace(/@(?:c\.us|s\.whatsapp\.net)$/, '');
}

export async function resolveCanonicalChat(chatId: string, id: string | undefined, actor: InboxActor, signal: AbortSignal) {
  if (!id) {
    const { data } = await api.get<{ success: boolean; conversationId?: string; reason?: string }>(
      `/chats/${encodeURIComponent(chatId)}/session/status`, { signal },
    );
    if (data?.success !== true) throw new Error('No se pudo confirmar la identidad de la conversación.');
    if (!data.conversationId && data.reason === 'legacy_webjs') return null;
    id = data.conversationId;
  }
  if (!id || !digits.test(id)) throw new Error('La conversación todavía no tiene una identidad de envío verificable.');
  const { data } = await api.get<CanonicalConversation>(endpoint(id), { signal });
  if (data?.id !== id || data.tenantId !== actor.tenantId || typeof data.externalConversationId !== 'string' ||
      !isSameChat(data.externalConversationId, chatId) || !Number.isSafeInteger(data.stateVersion) || data.stateVersion < 0) {
    throw new Error('No se pudo confirmar la conversación para esta empresa.');
  }
  return data;
}

export async function takeConversationControl(conversation: CanonicalConversation, actor: InboxActor) {
  const { data } = await api.post<CanonicalConversation>(endpoint(conversation.id) + '/takeover', {
    expectedVersion: conversation.stateVersion,
  });
  if (data?.id !== conversation.id || data.tenantId !== actor.tenantId || data.assignedUserId !== actor.id ||
      data.assignedAgentId !== null || data.aiPaused !== true || data.status !== 'open' ||
      data.stateVersion !== conversation.stateVersion + 1) {
    throw new Error('El servidor no confirmó la toma de control para tu sesión.');
  }
  return data;
}

export async function readCanonicalHistory(conversation: CanonicalConversation, signal: AbortSignal, clientRequestId?: string) {
  const { data } = await api.get<{ items: CanonicalMessage[] }>(endpoint(conversation.id) + '/messages', {
    params: clientRequestId ? { limit: 1, clientRequestId } : { limit: 50 }, signal,
  });
  if (!Array.isArray(data?.items) || !data.items.every((item) =>
    item.conversationId === conversation.id && item.tenantId === conversation.tenantId)) {
    throw new Error('El servidor no confirmó el historial de esta conversación.');
  }
  return data.items;
}

export async function sendCanonicalText(intent: TextIntent): Promise<SendOutcome> {
  const { data, status } = await api.post<SendReceipt>(endpoint(intent.conversationId) + '/messages', {
    expectedConversationVersion: intent.version,
    message: { kind: 'text', text: intent.text },
  }, { headers: { 'Idempotency-Key': intent.key } });
  return sendOutcome(status, data);
}

export async function sendCanonicalAttachment(intent: AttachmentIntent): Promise<SendOutcome> {
  const form = new FormData();
  form.set('file', intent.file);
  form.set('message', intent.caption);
  form.set('forceDocument', String(intent.forceDocument));
  form.set('expectedConversationVersion', String(intent.version));
  const { data, status } = await api.post<SendReceipt>(endpoint(intent.conversationId) + '/messages/attachments', form, {
    headers: { 'Content-Type': 'multipart/form-data', 'Idempotency-Key': intent.key },
  });
  return sendOutcome(status, data);
}

function sendOutcome(status: number, data: SendReceipt): SendOutcome {
  if (status === 202 && data?.accepted === true && typeof data.providerMessageId === 'string' && data.providerMessageId &&
      ['provider_accepted', 'dispatched', 'delivered', 'read'].includes(data.deliveryState)) {
    return { kind: 'accepted', deliveryState: data.deliveryState };
  }
  if (status === 202 && data?.accepted === false && data.deliveryState === 'failed') {
    return { kind: 'failed', deliveryState: 'failed' };
  }
  return { kind: 'unknown', deliveryState: 'unknown_delivery' };
}

const rejectionMessages: Record<string, string> = {
  CONVERSATION_VERSION_CHANGED: 'La conversación cambió. Actualiza su estado antes de volver a intentar.',
  HUMAN_TAKEOVER_REQUIRED: 'Toma el control de esta conversación con tu sesión antes de enviar.',
  CONVERSATION_CLOSED: 'La conversación está cerrada. El mensaje no se envió.',
  CONVERSATION_CHANNEL_UNSUPPORTED: 'El envío de texto está disponible para conversaciones verificadas de WhatsApp Cloud.',
  DELIVERY_UNRESOLVED: 'Hay un envío anterior sin confirmar. Actualiza su estado antes de iniciar otro.',
  SERVICE_WINDOW_CLOSED: 'La ventana de atención de 24 horas está cerrada. El mensaje no se envió.',
  SENDING_ACCOUNT_UNAVAILABLE: 'La conexión de WhatsApp de esta empresa no está disponible.',
  SENDING_ACCOUNT_UNVERIFIED: 'No se pudo verificar la cuenta de WhatsApp que recibió esta conversación.',
  IDEMPOTENCY_KEY_CONFLICT: 'La clave pertenece a otro intento. Consulta el historial antes de continuar.',
};

export function messageProblem(cause: unknown, kind?: 'text' | 'attachment'): MessageProblem {
  if (isAxiosError(cause)) {
    const { status, data } = cause.response ?? {};
    const reason = typeof data?.metadata?.reasonCode === 'string' ? data.metadata.reasonCode : '';
    if (kind === 'attachment' && (status === 413 || status === 415 || status === 422)) {
      let message = 'WhatsApp no admite este adjunto. Revisa su formato y el pie antes de volver a intentar.';
      if (status === 413 || reason === 'ATTACHMENT_SIZE_INVALID') {
        message = 'El archivo está vacío o supera el límite de WhatsApp. Elige un archivo más pequeño y vuelve a intentar.';
      } else if (reason === 'ATTACHMENT_CAPTION_UNSUPPORTED') {
        message = 'Los audios no admiten pie. Retíralo y vuelve a enviar el audio.';
      } else if (reason === 'ATTACHMENT_FILENAME_INVALID') {
        message = 'El nombre del archivo no es válido. Cámbialo y vuelve a adjuntarlo.';
      }
      return { reason, uncertain: false, message };
    }
    if (status && [400, 401, 403, 404, 409, 422, 429].includes(status)) {
      return { reason, uncertain: false, message: rejectionMessages[reason] ??
        (status === 409 ? 'La versión de la conversación cambió. Actualiza el estado y revisa la asignación.'
          : 'El servidor rechazó la solicitud. El mensaje no se envió.') };
    }
    return { reason, uncertain: true, message: 'No pudimos confirmar el resultado. Revisa este mismo intento antes de iniciar otro.' };
  }
  return { reason: '', uncertain: true, message: cause instanceof Error ? cause.message : 'No pudimos confirmar el resultado.' };
}

export function deliveryLabel(state: string | undefined) {
  if (state === 'sent') return 'Enviado';
  if (state === 'accepted' || state === 'provider_accepted' || state === 'dispatched') return 'Aceptado por WhatsApp';
  if (state === 'delivered') return 'Entregado';
  if (state === 'read') return 'Leído';
  if (state === 'failed') return 'No enviado';
  if (state === 'unknown_delivery') return 'Entrega sin confirmar';
  return undefined;
}
