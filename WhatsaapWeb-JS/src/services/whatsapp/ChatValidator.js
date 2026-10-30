/**
 * ChatValidator
 * Responsable de validar y filtrar chats y mensajes
 */
class ChatValidator {
  /**
   * Valida si un chat es válido para mostrar
   * @param {Object} chat - Chat de WhatsApp
   * @returns {boolean}
   */
  static isValidChat(chat) {
    return chat.id._serialized !== "status" &&
           chat.id._serialized !== "status@broadcast" &&
           !chat.id._serialized.includes("@newsletter") &&
           (!chat.isGroup || chat.id._serialized.includes("@g.us"));
  }

  /**
   * Determina si un mensaje es real (no es un evento de sistema)
   * @param {Object} message - Mensaje de WhatsApp
   * @returns {boolean}
   */
  static isRealMessage(message) {
    // Mensajes de sistema que debemos ignorar
    const systemTypes = [
      'gp2', // Eventos de grupo (el más común)
      'call_log', // Registro de llamadas
      'notification_template', // Notificaciones del sistema
      'revoked', // Mensajes eliminados
      'system', // Mensajes del sistema
    ];
    
    // Si es un tipo de sistema conocido, no es mensaje real
    if (systemTypes.includes(message.type)) {
      return false;
    }
    
    // Filtrar mensajes típicos de eventos de grupo por contenido
    if (message.body) {
      const systemPhrases = [
        'se unió usando el enlace de invitación',
        'añadió a',
        'eliminó a',
        'cambió el nombre del grupo',
        'cambió la descripción del grupo',
        'cambió la imagen del grupo',
        'dejó el grupo',
        'Te añadió',
        'Ahora eres administrador',
        'creó el grupo',
        'Salió del grupo'
      ];
      
      if (systemPhrases.some(phrase => message.body.includes(phrase))) {
        return false;
      }
    }
    
    // Todo lo demás se considera mensaje real
    return true;
  }

  /**
   * Ordena chats por actividad (no leídos primero, luego por timestamp)
   * @param {Array} chatsList - Lista de chats
   * @returns {Array} - Lista ordenada
   */
  static sortChats(chatsList) {
    return chatsList.sort((a, b) => {
      // 1. Prioridad máxima: mensajes no leídos
      if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
      if (b.unreadCount > 0 && a.unreadCount === 0) return 1;
      
      // 2. Ordenar por timestamp de último mensaje (igual que WhatsApp Web)
      return (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0);
    });
  }
}

module.exports = ChatValidator;
