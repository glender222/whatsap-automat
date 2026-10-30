/**
 * Ordena los chats igual que WhatsApp Web
 * @param {Array} chatsList - Lista de chats
 * @returns {Array} Lista ordenada
 */
function sortChatsByActivity(chatsList) {
  return chatsList.sort((a, b) => {
    // 1. Prioridad máxima: mensajes no leídos
    if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
    if (b.unreadCount > 0 && a.unreadCount === 0) return 1;
    
    // 2. Ordenar por timestamp de último mensaje (como WhatsApp Web)
    const timestampA = a.lastMessageTimestamp || 0;
    const timestampB = b.lastMessageTimestamp || 0;
    
    return timestampB - timestampA;
  });
}

/**
 * Valida si un chat es válido (no es canal, estado, etc.)
 * @param {Object} chat - Objeto chat de WhatsApp
 * @returns {boolean}
 */
function isValidChat(chat) {
  return chat.id._serialized !== "status" &&
         chat.id._serialized !== "status@broadcast" &&
         !chat.id._serialized.includes("@newsletter") &&
         (!chat.isGroup || chat.id._serialized.includes("@g.us"));
}

/**
 * Formatea un mensaje para la respuesta de la API
 * @param {Object} msg - Mensaje de WhatsApp
 * @param {string} chatId - ID del chat
 * @returns {Object} Mensaje formateado
 */
function formatMessage(msg, chatId) {
  return {
    id: msg.id._serialized,
    body: msg.body,
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    sender: msg.author || msg.from,
    type: msg.type === "ptt" ? "audio" : msg.type,
    mediaUrl: msg.hasMedia ? `/download-media/${msg.id._serialized}` : null,
    mimetype: msg._data?.mimetype || null,
    filename: msg._data?.filename || null,
    chatId: chatId,
  };
}

module.exports = {
  sortChatsByActivity,
  isValidChat,
  formatMessage
};