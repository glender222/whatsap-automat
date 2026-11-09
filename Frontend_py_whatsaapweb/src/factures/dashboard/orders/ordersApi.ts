import { isAxiosError } from 'axios';
import { api } from '../../../shared/axios/http';
import type { WhatsAppChat } from '../../../shared/types/wsp';
import { listProducts } from '../../inventario/services/productService';

export const ordersPath = '/dashboard/pedidos';
export const orderPageSize = 20;

const statusLabels: Record<string, string> = {
  draft: 'Borrador', quoted: 'Cotizado', pending_handoff: 'Pendiente de atención', pending_approval: 'Pendiente de aprobación',
  confirmed: 'Confirmado', reserved: 'Reservado', cancelled: 'Cancelado', completed: 'Completado',
  out_of_stock: 'Sin stock', unavailable: 'Disponibilidad insuficiente',
};
const availabilityLabels: Record<string, string> = {
  available: 'Disponible', reserved: 'Reservado', manual_required: 'Revisión manual',
  unlimited: 'Sin límite', unavailable: 'No disponible',
};
const preorders = ['draft', 'quoted', 'pending_handoff', 'pending_approval', 'out_of_stock', 'unavailable'];
const committed = ['confirmed', 'reserved'];
export type OrderAction = 'confirmed' | 'completed' | 'cancelled';
export interface OrderItem {
  id: number;
  itemNameSnapshot: string;
  quantity: number;
  unitPrice: number | null;
  currency: string;
  availabilityStatus: string;
}
export interface Order {
  id: number;
  companyId: number;
  title: string;
  status: string;
  occurredAt: string;
  confirmedAt: string | null;
  reservedAt: string | null;
  notes: string | null;
  metadata: { chatId?: string } | null;
  items: OrderItem[];
}
export interface DraftItem { commercialItemId: number; quantity: number }
interface Envelope<T> { success: boolean; data: T }

export function orderStatus(status: string) {
  return Object.hasOwn(statusLabels, status) ? statusLabels[status] : status;
}

export function itemAvailability(status: string) {
  return Object.hasOwn(availabilityLabels, status) ? availabilityLabels[status] : status;
}

export function orderActions(order: Order): OrderAction[] {
  if (preorders.includes(order.status) || (committed.includes(order.status) && !order.confirmedAt)) return ['confirmed', 'cancelled'];
  if (committed.includes(order.status)) return ['completed', 'cancelled'];
  return [];
}

export function orderError(cause: unknown, fallback: string) {
  if (!isAxiosError(cause)) return cause instanceof Error ? cause.message : fallback;
  const { status, data } = cause.response ?? {};
  if (data?.error === 'ORDER_STOCK_UNAVAILABLE') return 'La disponibilidad es insuficiente para reservar este pedido. Revisa las cantidades y el inventario.';
  if (data?.error === 'ORDER_ITEM_UNAVAILABLE') return 'El pedido contiene un artículo de catálogo que ya no está disponible.';
  if (data?.error === 'ORDER_CHAT_AMBIGUOUS') return 'El servidor encontró más de una conversación para este chat.';
  if (status === 409) return 'El servidor rechazó el cambio. ' + (typeof data?.message === 'string' ? data.message : 'Actualiza el pedido y consulta su estado.');
  if (status === 404) return 'El pedido o su referencia ya no está disponible para esta empresa.';
  if (status === 403) return 'Tu sesión no puede realizar esta operación.';
  if (status === 400 && typeof data?.message === 'string') return data.message;
  return fallback;
}

function confirmedOrder(order: Order | undefined, id?: number) {
  if (!order || !Number.isSafeInteger(order.id) || order.id < 1 || (id !== undefined && id !== order.id) ||
      typeof order.title !== 'string' || typeof order.status !== 'string' || !Array.isArray(order.items)) {
    throw new Error('El servidor no confirmó el pedido.');
  }
  return order;
}

export async function listOrders(offset: number, signal: AbortSignal) {
  const { data } = await api.get<Envelope<{ rows: Order[]; total: number }>>('/orders', {
    params: { limit: orderPageSize, offset }, signal,
  });
  if (data?.success !== true || !Array.isArray(data.data?.rows) ||
      !Number.isSafeInteger(data.data.total) || data.data.total < 0) {
    throw new Error('El servidor devolvió un listado de pedidos incompleto.');
  }
  return { rows: data.data.rows.map((row) => confirmedOrder(row)), total: data.data.total };
}

export async function readOrder(id: number, signal: AbortSignal) {
  const { data } = await api.get<Envelope<Order>>('/orders/' + id, { signal });
  return confirmedOrder(data?.success === true ? data.data : undefined, id);
}

export async function orderChats(offset: number, signal?: AbortSignal) {
  const limit = 50;
  const { data } = await api.get<Envelope<WhatsAppChat[]>>('/chats', { params: { limit, offset }, signal });
  if (data?.success !== true || !Array.isArray(data.data)) throw new Error('El servidor no confirmó el listado de chats.');
  return {
    chats: data.data.filter((chat) => typeof chat.id === 'string' && /^\d+$/.test(String(chat.conversationId ?? ''))),
    nextChatOffset: data.data.length === limit ? offset + limit : null,
  };
}

export async function orderChoices(signal: AbortSignal) {
  const [result, products] = await Promise.all([orderChats(0, signal), listProducts({ status: 'active' })]);
  return {
    ...result,
    products: products.filter((item) => item.status === 'active'),
  };
}

export async function savePreorder(chatId: string, items: DraftItem[]) {
  const { data, status } = await api.post<Envelope<{ order: Order }>>('/orders/detected', {
    chatId, items, status: 'draft', metadata: { source: 'web_operator' },
  });
  return confirmedOrder(status === 201 && data?.success === true ? data.data?.order : undefined);
}

export async function changeOrderStatus(order: Order, action: OrderAction) {
  const base = '/orders/' + order.id;
  const { data } = action === 'completed'
    ? await api.patch<Envelope<Order>>(base + '/status', { status: action })
    : await api.post<Envelope<Order>>(base + (action === 'confirmed' ? '/confirm' : '/cancel'));
  const saved = confirmedOrder(data?.success === true ? data.data : undefined, order.id);
  if (saved.companyId !== order.companyId || saved.status !== action) {
    throw new Error('El servidor no confirmó el cambio de estado solicitado.');
  }
  return saved;
}
