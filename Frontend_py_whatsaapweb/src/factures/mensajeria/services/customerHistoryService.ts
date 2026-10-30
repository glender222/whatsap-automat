import { api } from '../../../shared/axios/http';
import type { CustomerHistory } from '../types/customerHistoryTypes';

type CustomerHistoryResponse = {
  success: boolean;
  data: CustomerHistory;
  message?: string;
  error?: string;
};

export async function getCustomerHistoryByChat(chatId: string): Promise<CustomerHistory> {
  const response = await api.get<CustomerHistoryResponse>(
    `/customer-history/chats/${encodeURIComponent(chatId)}`,
    {
      params: {
        conversationLimit: 8,
        messageLimit: 30,
      },
    }
  );

  if (!response.data?.success || !response.data.data) {
    throw new Error(response.data?.message || 'No se pudo cargar el historial del cliente');
  }

  return response.data.data;
}
