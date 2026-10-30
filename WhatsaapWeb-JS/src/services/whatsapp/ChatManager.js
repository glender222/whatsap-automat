/**
 * ChatManager
 * Responsable de gestionar la lista de chats (cargar, actualizar, ordenar)
 */
const ChatValidator = require('./ChatValidator');
const { sortChatsByActivity } = require("../../utils/chatUtils");

class ChatManager {
  constructor(whatsappClient) {
    this.whatsappClient = whatsappClient;
    this.config = require("../../config");
  }

  /**
   * Carga todos los chats del usuario
   */
  async loadChats() {
    // EMITIR EVENTO ANTES de obtener chats
    if (this.whatsappClient.socketIO) {
      this.whatsappClient.socketIO.emit("loading-chats", {
        status: "fetching",
        message: "Obteniendo lista de chats..."
      });
    }
    console.log("📡 Obteniendo chats desde WhatsApp...");
    
    const chats = await this.whatsappClient.client.getChats();
    const validChats = chats.filter(chat => ChatValidator.isValidChat(chat));
    console.log(`Total de chats obtenidos: ${chats.length}`);
    console.log(`Chats válidos: ${validChats.length}`);
    
    // EMITIR EVENTO de inicio de procesamiento
    if (this.whatsappClient.socketIO) {
      this.whatsappClient.socketIO.emit("loading-chats", {
        status: "processing",
        total: validChats.length,
        message: `Procesando ${validChats.length} chats...`
      });
    }
    
    const INITIAL_BATCH = 50; // Primeros 50 chats para carga rápida
    const PROGRESSIVE_BATCH = 20; // Lotes de 20 para carga progresiva
    
    // FASE 1: Carga rápida de primeros 50
    const initialChats = validChats.slice(0, INITIAL_BATCH);
    console.log(`⚡ Cargando primeros ${initialChats.length} chats...`);
    
    this.whatsappClient.chatsList = await Promise.all(
      initialChats.map(async (chat) => await this.processChatForList(chat))
    );
    
    // Ordenar
    this.whatsappClient.chatsList = ChatValidator.sortChats(this.whatsappClient.chatsList);
    
    // Emitir INMEDIATAMENTE al frontend
    if (this.whatsappClient.socketIO) {
      this.whatsappClient.socketIO.emit("chats-updated", this.whatsappClient.chatsList);
      this.whatsappClient.socketIO.emit("loading-chats", {
        status: "initial-loaded",
        loaded: this.whatsappClient.chatsList.length,
        total: validChats.length,
        percentage: Math.round((this.whatsappClient.chatsList.length / validChats.length) * 100),
        message: `${this.whatsappClient.chatsList.length} de ${validChats.length} chats cargados`
      });
    }
    
    console.log(`✅ Primeros ${this.whatsappClient.chatsList.length} chats cargados y enviados al frontend`);
    
    // FASE 2: Carga progresiva del resto
    if (validChats.length > INITIAL_BATCH) {
      const remainingChats = validChats.slice(INITIAL_BATCH);
      console.log(`📦 Cargando ${remainingChats.length} chats restantes en segundo plano...`);
      
      // Cargar en lotes para no bloquear
      for (let i = 0; i < remainingChats.length; i += PROGRESSIVE_BATCH) {
        const batch = remainingChats.slice(i, i + PROGRESSIVE_BATCH);
        
        try {
          const processedBatch = await Promise.all(
            batch.map(async (chat) => await this.processChatForList(chat))
          );
          
          this.whatsappClient.chatsList.push(...processedBatch);
          this.whatsappClient.chatsList = ChatValidator.sortChats(this.whatsappClient.chatsList);
          
          // Emitir actualización progresiva EN TIEMPO REAL
          const percentage = Math.round((this.whatsappClient.chatsList.length / validChats.length) * 100);
          
          if (this.whatsappClient.socketIO) {
            this.whatsappClient.socketIO.emit("chats-updated", this.whatsappClient.chatsList);
            this.whatsappClient.socketIO.emit("loading-chats", {
              status: "loading",
              loaded: this.whatsappClient.chatsList.length,
              total: validChats.length,
              percentage: percentage,
              message: `Cargando chats: ${this.whatsappClient.chatsList.length}/${validChats.length} (${percentage}%)`
            });
          }
          
          console.log(`📊 Progreso: ${this.whatsappClient.chatsList.length}/${validChats.length} (${percentage}%)`);
          
        } catch (error) {
          console.error(`Error procesando lote en posición ${i}:`, error);
        }
      }
      
      // Notificar finalización
      if (this.whatsappClient.socketIO) {
        this.whatsappClient.socketIO.emit("loading-chats", {
          status: "completed",
          loaded: this.whatsappClient.chatsList.length,
          total: validChats.length,
          percentage: 100,
          message: "Todos los chats cargados"
        });
      }
      
      console.log(`✅ Carga completa: ${this.whatsappClient.chatsList.length} chats en total`);
    } else {
      // Si hay menos de 50 chats, ya terminamos
      if (this.whatsappClient.socketIO) {
        this.whatsappClient.socketIO.emit("loading-chats", {
          status: "completed",
          loaded: this.whatsappClient.chatsList.length,
          total: validChats.length,
          percentage: 100,
          message: "Todos los chats cargados"
        });
      }
    }
  }

  /**
   * Procesa un chat individual para agregarlo a la lista
   * @param {Object} chat - Chat de WhatsApp
   * @returns {Object} - Objeto con datos del chat
   */
  async processChatForList(chat) {
    let lastMessageTimestamp = 0;
    let lastMessage = null;
    
    try {
      // Obtener más mensajes para filtrar eventos de sistema
      const messages = await chat.fetchMessages({ limit: 10 });

      // Asegurar que iteramos desde el más reciente al más antiguo
      messages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      // Buscar el último mensaje real (más reciente)
      for (const msg of messages) {
        if (ChatValidator.isRealMessage(msg)) {
          lastMessage = msg;
          lastMessageTimestamp = msg.timestamp;
          break;
        }
      }
      
    } catch (error) {
      console.log(`Error obteniendo mensajes para ${chat.name || chat.id.user}: ${error.message}`);
    }
    
    // Si no hay mensajes reales, usar timestamp muy bajo para que aparezca al final
    if (lastMessageTimestamp === 0) {
      if (chat.isGroup) {
        // Para grupos sin mensajes reales, usar timestamp muy bajo
        lastMessageTimestamp = 1;
      } else if (chat.timestamp) {
        // Para contactos individuales, usar timestamp del chat
        lastMessageTimestamp = chat.timestamp;
      }
    }
    
    return {
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      lastMessageTimestamp,
      unreadCount: chat.unreadCount || 0,
      isGroup: chat.isGroup || false,
      lastMessagePreview: lastMessage ? 
        ((lastMessage.body && lastMessage.body.trim()) ? 
          lastMessage.body.substring(0, 50) : 
          (lastMessage.hasMedia ? '[Media]' : null)) : null
    };
  }

  /**
   * Actualiza un chat en la lista
   * @param {Object} chat - Chat de WhatsApp
   * @param {number} timestamp - Timestamp del mensaje
   * @param {Object} msg - Mensaje (opcional)
   */
  async updateChatInList(chat, timestamp, msg = null) {
    const chatId = chat.id._serialized;
    const idx = this.whatsappClient.chatsList.findIndex((c) => c.id === chatId);
    const previewFromMsg = msg ? 
      ((msg.body && msg.body.trim()) ? 
        msg.body.substring(0, 50) : 
        (msg.hasMedia ? '[Media]' : null)) : null;

    if (idx > -1) {
      this.whatsappClient.chatsList[idx].lastMessageTimestamp = timestamp;
      this.whatsappClient.chatsList[idx].unreadCount = chat.unreadCount || 0;
      this.whatsappClient.chatsList[idx].name = chat.name || chat.id.user;
      // Actualizar preview si recibimos el mensaje real en tiempo real
      if (previewFromMsg) {
        this.whatsappClient.chatsList[idx].lastMessagePreview = previewFromMsg;
      }
    } else {
      this.whatsappClient.chatsList.push({
        id: chatId,
        name: chat.name || chat.id.user,
        lastMessageTimestamp: timestamp,
        unreadCount: chat.unreadCount || 0,
        lastMessagePreview: previewFromMsg || null
      });
    }
    
    this.whatsappClient.chatsList = sortChatsByActivity(this.whatsappClient.chatsList);
  }

  /**
   * Refresca los chats recientes (polling ligero)
   */
  async refreshRecentChats() {
    if (!this.whatsappClient.client || !this.whatsappClient.isConnected) return;

    try {
      const pollLimit = this.config.whatsapp.pollLimit || 20;
      const chats = await this.whatsappClient.client.getChats();
      const toCheck = chats
        .filter(chat => ChatValidator.isValidChat(chat))
        .slice(0, pollLimit);

      for (const chat of toCheck) {
        try {
          const messages = await chat.fetchMessages({ limit: 1 });
          if (!messages || messages.length === 0) continue;
          const msg = messages[0];
          if (!ChatValidator.isRealMessage(msg)) continue;

          const chatId = chat.id._serialized;
          const idx = this.whatsappClient.chatsList.findIndex(c => c.id === chatId);
          const lastTs = msg.timestamp || 0;

          if (idx === -1) {
            // No estaba en la lista, agregar
            this.whatsappClient.chatsList.push({
              id: chatId,
              name: chat.name || chat.id.user,
              lastMessageTimestamp: lastTs,
              unreadCount: chat.unreadCount || 0,
              lastMessagePreview: (msg.body && msg.body.trim()) ? 
                msg.body.substring(0,50) : 
                (msg.hasMedia ? '[Media]' : null)
            });
            continue;
          }

          // Si el mensaje polled es más reciente que lo que tenemos, actualizar
          if ((this.whatsappClient.chatsList[idx].lastMessageTimestamp || 0) < lastTs) {
            this.whatsappClient.chatsList[idx].lastMessageTimestamp = lastTs;
            this.whatsappClient.chatsList[idx].unreadCount = chat.unreadCount || 0;
            this.whatsappClient.chatsList[idx].name = chat.name || chat.id.user;
            this.whatsappClient.chatsList[idx].lastMessagePreview = (msg.body && msg.body.trim()) ? 
              msg.body.substring(0,50) : 
              (msg.hasMedia ? '[Media]' : null);
          }

        } catch (e) {
          console.debug('Error polling chat', chat.id?._serialized, e.message || e);
        }
      }

      // Reordenar y emitir si hay cambios
      this.whatsappClient.chatsList = sortChatsByActivity(this.whatsappClient.chatsList);
      if (this.whatsappClient.socketIO) {
        this.whatsappClient.socketIO.emit('chats-updated', this.whatsappClient.chatsList);
      }

    } catch (error) {
      console.warn('Error en refreshRecentChats (global):', error.message || error);
    }
  }
}

module.exports = ChatManager;
