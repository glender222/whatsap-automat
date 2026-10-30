/**
 * MessageHandler
 * Responsable del manejo de mensajes (enviar, recibir, formatear)
 */
const { MessageMedia } = require("whatsapp-web.js");
const { sortChatsByActivity } = require("../../utils/chatUtils");

class MessageHandler {
  constructor(whatsappClient) {
    this.whatsappClient = whatsappClient;
  }

  /**
   * Formatea un mensaje para enviarlo al frontend
   * @param {Object} msg - Mensaje de WhatsApp
   * @param {string} chatId - ID del chat
   * @returns {Object} - Mensaje formateado
   */
  formatMessage(msg, chatId) {
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

  /**
   * Obtiene los mensajes de un chat
   * @param {string} chatId - ID del chat
   * @param {number} limit - Límite de mensajes
   * @param {number} before - Timestamp antes del cual buscar
   * @returns {Array} - Lista de mensajes formateados
   */
  async getChatMessages(chatId, limit = 50, before = 0) {
    const chat = await this.whatsappClient.client.getChatById(chatId);
    let options = { limit };
    
    if (before > 0) {
      options = { ...options, before };
    }

    const messages = await chat.fetchMessages(options);
    const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);

    return sorted.map((msg) => this.formatMessage(msg, chatId));
  }

  /**
   * Envía un mensaje (texto o con multimedia)
   * @param {string} chatId - ID del chat
   * @param {string} message - Mensaje de texto
   * @param {Object} media - Archivo multimedia (opcional)
   * @returns {Object} - Mensaje enviado
   */
  async sendMessage(chatId, message, media = null, options = {}) {
    let sentMessage;
    if (media) {
      try {
        console.log(`Enviando media. chatId=${chatId}, path=${media.path}, mimetype=${media.mimetype}, originalname=${media.originalname}, size=${media.size}`);
        const mediaMessage = MessageMedia.fromFilePath(media.path);
        mediaMessage.mimetype = media.mimetype;
        mediaMessage.filename = media.originalname;

        // Detectar si es video, imagen, audio o documento
        const isVideo = media.mimetype && media.mimetype.startsWith('video/');
        const isImage = media.mimetype && media.mimetype.startsWith('image/');
        const isAudio = media.mimetype && media.mimetype.startsWith('audio/');
        const isDocument = !isVideo && !isImage && !isAudio;

        // Respetar forceDocument si viene en options
        const sendAsDocument = options.forceDocument === true || (typeof options.forceDocument === 'string' && options.forceDocument === 'true') || isDocument;

        sentMessage = await this.whatsappClient.client.sendMessage(
          chatId,
          mediaMessage,
          {
            caption: message || "",
            ...(sendAsDocument ? { sendMediaAsDocument: true } : {})
          }
        );
      } catch (err) {
        const extra = {
          chatId,
          file: {
            path: media.path,
            mimetype: media.mimetype,
            originalname: media.originalname,
            size: media.size
          },
          clientState: this.whatsappClient.client ?
            (typeof this.whatsappClient.client.getState === 'function' ?
              this.whatsappClient.client.getState() : 'unknown') : 'no-client'
        };

        console.error('Error enviando media via client.sendMessage:', err && err.message ? err.message : err, extra);

        // Intentar fallback: enviar como documento
        try {
          console.log('Intentando fallback: enviar media como documento (sendMediaAsDocument=true)');
          const mediaMessage2 = MessageMedia.fromFilePath(media.path);
          mediaMessage2.mimetype = media.mimetype;
          mediaMessage2.filename = media.originalname;

          sentMessage = await this.whatsappClient.client.sendMessage(chatId, mediaMessage2, {
            caption: message || "",
            sendMediaAsDocument: true
          });

          console.log('Fallback exitoso: enviado como documento');
        } catch (err2) {
          console.error('Fallback falló al enviar como documento:', err2 && err2.message ? err2.message : err2);

          const e = new Error(`Error sending media (original: ${err && err.message ? err.message : err}; fallback: ${err2 && err2.message ? err2.message : err2})`);
          e.cause = err2;
          e.extra = extra;
          throw e;
        }
      }
    } else if (message) {
      sentMessage = await this.whatsappClient.client.sendMessage(chatId, message);
    } else {
      throw new Error("No hay mensaje ni archivo para enviar");
    }

    // Actualizar orden de chat
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const idx = this.whatsappClient.chatsList.findIndex((c) => c.id === chatId);
    const preview = media ? '[Media]' : (message ? (message.toString().substring(0,50)) : null);

    if (idx > -1) {
      this.whatsappClient.chatsList[idx].lastMessageTimestamp = currentTimestamp;
      if (preview) this.whatsappClient.chatsList[idx].lastMessagePreview = preview;
    }

    this.whatsappClient.chatsList = sortChatsByActivity(this.whatsappClient.chatsList);

    if (this.whatsappClient.socketIO) {
      this.whatsappClient.socketIO.emit("chats-updated", this.whatsappClient.chatsList);
    }

    return sentMessage;
  }

  /**
   * Marca un chat como leído
   * @param {string} chatId - ID del chat
   */
  async markAsRead(chatId) {
    const chat = await this.whatsappClient.client.getChatById(chatId);
    if (chat.unreadCount > 0) {
      await chat.sendSeen();
      
      const idx = this.whatsappClient.chatsList.findIndex((c) => c.id === chatId);
      if (idx > -1) {
        this.whatsappClient.chatsList[idx].unreadCount = 0;
      }
      
      if (this.whatsappClient.socketIO) {
        this.whatsappClient.socketIO.emit("chats-updated", this.whatsappClient.chatsList);
      }
    }
  }
}

module.exports = MessageHandler;
