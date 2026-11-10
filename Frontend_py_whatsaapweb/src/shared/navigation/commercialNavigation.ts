export const ordersPath = '/dashboard/pedidos';

export function positiveInt(value: string | null): number | null {
  const number = Number(value);
  return value && /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function conversationLocation(chatId: string): string {
  return `/gestion-web/inicio?${new URLSearchParams({ chat: chatId })}`;
}

export function orderLocation(page: number, id?: number, chatId?: string): string {
  const params = new URLSearchParams();
  if (id !== undefined) params.set('pedido', String(id));
  if (page > 1) params.set('pagina', String(page));
  if (chatId) params.set('chat', chatId);
  return params.size ? `${ordersPath}?${params}` : ordersPath;
}

export function paymentLocation(orderId: number, page = 1, chatId?: string): string {
  const params = new URLSearchParams({ pedido: String(orderId) });
  if (page > 1) params.set('paginaPedidos', String(page));
  if (chatId) params.set('chat', chatId);
  return `/dashboard/pagos?${params}`;
}
