import { api } from '../../../shared/axios/http';
import type { CustomerHistory } from '../types/customerHistoryTypes';

type CustomerHistoryResponse = {
  success: boolean;
  data: CustomerHistory;
  message?: string;
  error?: string;
};

export async function getCustomerHistoryByChat(chatId: string, signal?: AbortSignal): Promise<CustomerHistory> {
  const response = await api.get<CustomerHistoryResponse>(
    `/customer-history/chats/${encodeURIComponent(chatId)}`,
    {
      signal,
      params: {
        conversationLimit: 8,
        messageLimit: 30,
      },
    }
  );

  const history = response.data?.data;
  if (!response.data?.success || !history) {
    throw new Error(response.data?.message || 'No se pudo cargar el historial del cliente.');
  }
  if (!history.contact || typeof history.contact !== 'object' || Array.isArray(history.contact) ||
      ![history.conversations, history.recentMessages, history.tags, history.orders, history.actions].every(Array.isArray)) {
    throw new Error('El historial del cliente no está disponible en un formato válido.');
  }

  return history;
}
