import { Router, Request, Response, NextFunction } from 'express';
import WhatsAppService from '../services/whatsappService';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import pool from '../config/database';
import { OperationalRecordRepositoryPg, OperationalRecordService } from '../modules/operations';
import AgentService from '../services/ai/AgentService';

const multer = require('multer') as any;

export function createChatCompatRoutes(whatsappService: WhatsAppService): Router {
  const router = Router();
  const operationalRecords = new OperationalRecordService(new OperationalRecordRepositoryPg(pool));
  const agentService = new AgentService();
  const upload = multer({
    dest: config.multer.dest,
    limits: { fileSize: config.multer.maxFileSize },
  });

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const offset = parseInt(String(req.query.offset || '0'), 10);
      const chats = whatsappService.provider === 'meta-cloud'
        ? await whatsappService.getMetaStore(companyId)?.getChats({ limit, offset })
        : await whatsappService.getChatsList(companyId);
      res.json({ success: true, data: chats || [] });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:chatId/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const before = parseInt(String(req.query.before || '0'), 10);
      const messages = await whatsappService.getChatMessages(String(req.params.chatId), limit, before, companyId);
      res.json({ success: true, data: messages, total: messages.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:chatId/session/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const chatId = String(req.params.chatId);
      const status = await whatsappService.getChatSessionStatus(chatId, companyId);
      res.json({
        success: true,
        chatId,
        ...status,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:chatId/ai-session', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const chatId = String(req.params.chatId);
      const session = await agentService.getChatAiSession(companyId, chatId);
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:chatId/agent-activity', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const chatId = String(req.params.chatId);
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const activity = await agentService.listChatAgentActivity(companyId, chatId, limit);
      res.json({ success: true, data: activity });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:chatId/sessions/complete', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const chatId = String(req.params.chatId);
      const result = await operationalRecords.completeServiceSession({
        companyId,
        chatId,
        userId: getUserId(req as JwtRequest),
      });
      await agentService.closeChatAiSessions(companyId, chatId);

      res.json({
        success: true,
        message: 'Sesion finalizada',
        chatId,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:chatId/messages', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const body = req.body as Record<string, string>;
      const file = (req as any).file || null;
      const message = body.message || '';
      const templateName = body.templateName || body.template;
      const templateLanguage = body.templateLanguage || body.language;

      if (!message && !file && !templateName) {
        return res.status(400).json({
          success: false,
          error: 'Mensaje, archivo o template es requerido',
        });
      }

      const sent = await whatsappService.sendMessage(String(req.params.chatId), message, file, {
        forceDocument: body.forceDocument === 'true',
        ptt: body.ptt === 'true',
        asSticker: body.asSticker === 'true',
        templateName,
        templateLanguage,
        companyId,
      });

      const messageId = sent?.id?._serialized || sent?.id || null;
      operationalRecords.recordMessageSent({
        companyId,
        chatId: String(req.params.chatId),
        userId: getUserId(req as JwtRequest),
      }, messageId ? String(messageId) : null).catch((error) => {
        console.warn('No se pudo registrar accion operativa de mensaje enviado:', error?.message || error);
      });

      return res.json({
        success: true,
        messageId,
        sentType: file ? 'media' : (templateName ? 'template' : 'text'),
        data: {
          sentType: file ? 'media' : (templateName ? 'template' : 'text'),
          messageId,
          timestamp: sent?.timestamp || Math.floor(Date.now() / 1000),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  const markAsRead = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      await whatsappService.markAsRead(String(req.params.chatId), companyId);
      res.json({ success: true, message: 'Chat marcado como leido' });
    } catch (error) {
      next(error);
    }
  };

  router.post('/:chatId/read', markAsRead);
  router.put('/:chatId/read', markAsRead);

  return router;
}

function getUserId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export default createChatCompatRoutes;
