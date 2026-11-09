import { api } from '../../../shared/axios/http';

export async function markChatAsRead(chatId: string) {
  const response = await api.put(`/chats/${encodeURIComponent(chatId)}/read`);
  return response.data;
}
