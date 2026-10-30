/**
 * WhatsAppService (Facade Pattern)
 * Punto de entrada principal que delega funcionalidad a componentes especializados
 */
const WhatsAppClient = require('./whatsapp/WhatsAppClient');

class WhatsAppService {
  constructor() {
    this.provider = 'webjs';
    this.whatsappClient = new WhatsAppClient();
  }

  // ==========================================
  // Métodos de conexión y configuración
  // ==========================================

  setSocketIO(io) {
    this.whatsappClient.setSocketIO(io);
  }

  setConversationCore(core) {
    this.conversationCore = core;
  }

  getConversationCore() {
    return this.conversationCore || null;
  }

  async initialize() {
    return await this.whatsappClient.initialize();
  }

  getQR() {
    return this.whatsappClient.getQR();
  }

  getStatus() {
    return this.whatsappClient.getStatus();
  }

  getMyInfo() {
    return this.whatsappClient.getMyInfo();
  }

  async logout() {
    return await this.whatsappClient.logout();
  }

  async destroy() {
    return await this.whatsappClient.destroy();
  }

  // ==========================================
  // Métodos de gestión de chats
  // ==========================================

  getChats() {
    return this.whatsappClient.getChats();
  }

  // ==========================================
  // Métodos de mensajes
  // ==========================================

  async getChatMessages(chatId, limit = 50, before = 0) {
    return await this.whatsappClient.messageHandler.getChatMessages(chatId, limit, before);
  }

  async sendMessage(chatId, message, media = null, options = {}) {
    // options: { forceDocument, ptt, asSticker }
    return await this.whatsappClient.messageHandler.sendMessage(chatId, message, media, options);
  }
  // ===================== NUEVOS MÉTODOS PARA MEDIA ROBUSTA =====================

  async getChatsList() {
    // Implementar en WhatsAppClient/ChatManager si no existe
    if (typeof this.whatsappClient.getChatsList === 'function') {
      return await this.whatsappClient.getChatsList();
    }
    // fallback: getChats
    return this.getChats();
  }

  async getMediaInfo(messageId) {
    if (typeof this.whatsappClient.mediaHandler.getMediaInfo === 'function') {
      return await this.whatsappClient.mediaHandler.getMediaInfo(messageId);
    }
    return null;
  }

  async getMediaThumbnail(messageId) {
    if (typeof this.whatsappClient.mediaHandler.getMediaThumbnail === 'function') {
      return await this.whatsappClient.mediaHandler.getMediaThumbnail(messageId);
    }
    return null;
  }

  async markAsRead(chatId) {
    return await this.whatsappClient.messageHandler.markAsRead(chatId);
  }

  // ==========================================
  // Métodos de multimedia
  // ==========================================

  async downloadMedia(messageId) {
    return await this.whatsappClient.mediaHandler.downloadMedia(messageId);
  }

  async getProfilePhoto(chatId) {
    return await this.whatsappClient.mediaHandler.getProfilePhoto(chatId);
  }
}

module.exports = WhatsAppService;
