const { asyncHandler } = require('../middleware/errorHandler');
const config = require('../config');

function getTenantCompanyId(req) {
  const user = req?.user || {};
  const companyId = Number(
    req?.whatsappCompanyId ||
    user.companyId ||
    user.company_id ||
    user.tenantId
  );
  if (Number.isInteger(companyId) && companyId > 0) {
    return companyId;
  }
  throw new Error('TENANT_CLAIM_REQUIRED: Se requiere un token con claim de empresa valido');
}

class ChatController {
  constructor(whatsappService, conversationCore = null) {
    this.whatsappService = whatsappService;
    this.conversationCore = conversationCore;
  }

  async _logFallback(action, entityType, entityId, error, endpoint, req = null) {
    if (!this.conversationCore) return;
    try {
      const companyId = req ? getTenantCompanyId(req) : null;
      if (!companyId) return;
      await this.conversationCore.repositories.auditLogRepository.log({
        companyId,
        actor: 'system',
        action,
        entityType,
        entityId,
        metadataJson: { error: error?.message || String(error), endpoint },
      });
    } catch (e) {
      // ignore audit failures
    }
  }

  // GET /chats (compatibilidad legacy)
  getChatsLegacy = asyncHandler(async (req, res) => {
    const companyId = getTenantCompanyId(req);
    if (config.features?.persistReads && this.conversationCore) {
      try {
        const conversations = await this.conversationCore.repositories.conversationRepository.findByCompany(companyId, 50, 0);
        if (conversations && conversations.length > 0) {
          const chats = conversations.map(c => ({
            id: c.externalConversationId,
            name: c.title || c.externalConversationId,
            lastMessageTimestamp: c.lastMessageAt ? Math.floor(new Date(c.lastMessageAt).getTime() / 1000) : null,
            unreadCount: c.unreadCount || 0,
            isGroup: false,
            lastMessagePreview: null,
          }));
          res.json(chats);
          return;
        }
      } catch (err) {
        console.error('❌ DB read fallback for getChatsLegacy:', err.message);
        await this._logFallback('fallback_legacy_read', 'chats', 'list', err, 'getChatsLegacy', req);
      }
    }
    const chats = typeof this.whatsappService.getChatsList === 'function'
      ? await this.whatsappService.getChatsList(companyId)
      : this.whatsappService.getChats();
    res.json(chats);
  });

  // GET /messages/:chatId (compatibilidad legacy)
  getMessagesLegacy = asyncHandler(async (req, res) => {
    const companyId = getTenantCompanyId(req);
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit || "50", 10);
    const before = parseInt(req.query.before || "0", 10);

    if (!chatId) {
      return res.status(400).json({ error: "ChatId es requerido" });
    }

    if (config.features?.persistReads && this.conversationCore) {
      try {
        const conversation = await this.conversationCore.repositories.conversationRepository.findByExternal(companyId, 'whatsapp', chatId);
        if (conversation) {
          const messages = await this.conversationCore.repositories.messageRepository.findByConversation(conversation.id, limit, before);
          if (messages && messages.length > 0) {
            const formatted = messages.map(m => ({
              id: m.providerMessageId || String(m.id),
              body: m.body,
              fromMe: m.direction === 'outbound',
              timestamp: Math.floor(new Date(m.occurredAt).getTime() / 1000),
              sender: m.direction === 'outbound' ? 'me' : conversation.externalConversationId,
              type: m.messageType,
              mediaUrl: null,
              mimetype: null,
              filename: null,
              chatId,
            }));
            res.json(formatted);
            return;
          }
        }
      } catch (err) {
        console.error('❌ DB read fallback for getMessagesLegacy:', err.message);
        await this._logFallback('fallback_legacy_read', 'messages', chatId, err, 'getMessagesLegacy', req);
      }
    }

    try {
      const messages = await this.whatsappService.getChatMessages(chatId, limit, before, companyId);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: "No se pudo obtener los mensajes" });
    }
  });

  // GET /api/chats
  getChats = asyncHandler(async (req, res) => {
    const companyId = getTenantCompanyId(req);
    if (config.features?.persistReads && this.conversationCore) {
      try {
        const conversations = await this.conversationCore.repositories.conversationRepository.findByCompany(companyId, 50, 0);
        if (conversations && conversations.length > 0) {
          const chats = conversations.map(c => ({
            id: c.externalConversationId,
            name: c.title || c.externalConversationId,
            lastMessageTimestamp: c.lastMessageAt ? Math.floor(new Date(c.lastMessageAt).getTime() / 1000) : null,
            unreadCount: c.unreadCount || 0,
            isGroup: false,
            lastMessagePreview: null,
          }));
          res.json({ success: true, data: chats });
          return;
        }
      } catch (err) {
        console.error('❌ DB read fallback for getChats:', err.message);
        await this._logFallback('fallback_legacy_read', 'chats', 'list', err, 'getChats', req);
      }
    }
    const chats = typeof this.whatsappService.getChatsList === 'function'
      ? await this.whatsappService.getChatsList(companyId)
      : this.whatsappService.getChats();
    res.json({ success: true, data: chats });
  });

  // GET /api/chats/:chatId/messages
  getMessages = asyncHandler(async (req, res) => {
    const companyId = getTenantCompanyId(req);
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit || "50", 10);
    const before = parseInt(req.query.before || "0", 10);

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: "ChatId es requerido"
      });
    }

    if (config.features?.persistReads && this.conversationCore) {
      try {
        const conversation = await this.conversationCore.repositories.conversationRepository.findByExternal(companyId, 'whatsapp', chatId);
        if (conversation) {
          const messages = await this.conversationCore.repositories.messageRepository.findByConversation(conversation.id, limit, before);
          if (messages && messages.length > 0) {
            const formatted = messages.map(m => ({
              id: m.providerMessageId || String(m.id),
              body: m.body,
              fromMe: m.direction === 'outbound',
              timestamp: Math.floor(new Date(m.occurredAt).getTime() / 1000),
              sender: m.direction === 'outbound' ? 'me' : conversation.externalConversationId,
              type: m.messageType,
              mediaUrl: null,
              mimetype: null,
              filename: null,
              chatId,
            }));
            res.json({ success: true, data: formatted });
            return;
          }
        }
      } catch (err) {
        console.error('❌ DB read fallback for getMessages:', err.message);
        await this._logFallback('fallback_legacy_read', 'messages', chatId, err, 'getMessages', req);
      }
    }

    const messages = await this.whatsappService.getChatMessages(chatId, limit, before, companyId);
    res.json({ success: true, data: messages });
  });

  // POST /send-message (compatibilidad legacy)
  sendMessageLegacy = asyncHandler(async (req, res) => {
    const companyId = getTenantCompanyId(req);
    const { chatId, message } = req.body;
    const file = req.file;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: "Falta parámetro chatId"
      });
    }

    if (!message && !file) {
      return res.status(400).json({
        success: false,
        error: "No hay mensaje ni archivo para enviar"
      });
    }

    if (config.features?.persistWrites && this.conversationCore && !file) {
      try {
        const dto = {
          companyId,
          channel: 'whatsapp',
          externalConversationId: chatId,
          externalContactId: chatId,
          clientRequestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          body: message || '',
          messageType: 'text',
        };
        const result = await this.conversationCore.conversationService.requestOutbound(dto);
        res.json({
          success: true,
          sentType: "text",
          messageId: result.providerMessageId || (result.message ? String(result.message.id) : null),
        });
        return;
      } catch (err) {
        console.error('❌ Core outbound failed, falling back to legacy:', err.message);
        await this._logFallback('fallback_legacy_write', 'message', chatId, err, 'sendMessageLegacy', req);
      }
    }

    const sentMessage = await this.whatsappService.sendMessage(chatId, message, file, { companyId });

    if (file && file.path) {
      const fs = require('fs');
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        console.warn('No se pudo eliminar archivo temporal:', file.path);
      }
    }

    res.json({
      success: true,
      sentType: file ? "media" : "text",
      messageId: sentMessage?.id?._serialized
    });
  });

  // POST /api/chats/:chatId/messages
  sendMessage = asyncHandler(async (req, res) => {
    const companyId = getTenantCompanyId(req);
    const { chatId } = req.params;
    const { message, templateName, template, templateLanguage, language } = req.body;
    const file = req.file;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: "ChatId es requerido"
      });
    }

    if (!message && !file && !templateName && !template) {
      return res.status(400).json({
        success: false,
        error: "Mensaje, archivo o template es requerido"
      });
    }

    if (config.features?.persistWrites && this.conversationCore && !file) {
      try {
        const dto = {
          companyId,
          channel: 'whatsapp',
          externalConversationId: chatId,
          externalContactId: chatId,
          clientRequestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          body: message || '',
          messageType: 'text',
        };
        const result = await this.conversationCore.conversationService.requestOutbound(dto);
        res.json({
          success: true,
          data: {
            sentType: "text",
            messageId: result.providerMessageId || (result.message ? String(result.message.id) : null),
          }
        });
        return;
      } catch (err) {
        console.error('❌ Core outbound failed, falling back to legacy:', err.message);
        await this._logFallback('fallback_legacy_write', 'message', chatId, err, 'sendMessage', req);
      }
    }

    const sentMessage = await this.whatsappService.sendMessage(chatId, message, file, {
      templateName: templateName || template,
      templateLanguage: templateLanguage || language,
      companyId,
    });

    if (file && file.path) {
      const fs = require('fs');
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        console.warn('No se pudo eliminar archivo temporal:', file.path);
      }
    }

    res.json({
      success: true,
      data: {
        sentType: file ? "media" : "text",
        messageId: sentMessage?.id?._serialized || sentMessage?.id || null
      }
    });
  });

  // PUT /api/chats/:chatId/read
  markAsRead = asyncHandler(async (req, res) => {
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: "ChatId es requerido"
      });
    }

    if (chatId.includes("@newsletter")) {
      return res.status(400).json({
        success: false,
        error: "No se puede marcar como leído un canal"
      });
    }

    await this.whatsappService.markAsRead(chatId);

    res.json({
      success: true,
      message: "Chat marcado como leído"
    });
  });
}

module.exports = ChatController;
