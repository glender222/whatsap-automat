import { Router, Request, Response, NextFunction } from 'express';
import WhatsAppService from '../services/whatsappService';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { requireChatTenantAccess } from '../middleware/resourceAuth';
import { cleanRejectedUpload, explicitTemplateName, legacyHumanSend } from '../middleware/legacyHumanSend';

const { requireAdmin } = require('../middleware/authMiddleware');
const multer = require('multer') as any;

export function createWhatsAppRoutes(whatsappService: WhatsAppService): Router {
  const router = Router();
  const upload = multer({
    dest: config.multer.dest,
    limits: { fileSize: config.multer.maxFileSize },
  });

  router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      res.json(await whatsappService.getCompanyStatus(companyId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/qr', (req: JwtRequest, res: Response, next: NextFunction) => {
    if (whatsappService.provider !== 'webjs') return res.json({ qr: null, provider: whatsappService.provider });
    return requireAdmin(req, res, () => {
      try {
        const qr = whatsappService.getQR(resolveWhatsappCompanyId(req));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ qr, provider: whatsappService.provider });
      } catch (error) {
        next(error);
      }
    });
  });

  router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const info = await whatsappService.getMyInfo(resolveWhatsappCompanyId(req as JwtRequest));
      if (!info) {
        return res.status(503).json({
          success: false,
          error: 'WhatsApp no configurado o no disponible',
        });
      }
      return res.json(info);
    } catch (error) {
      next(error);
    }
  });

  router.post('/init', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      await whatsappService.initialize(companyId);
      res.json({
        success: true,
        provider: whatsappService.provider,
        status: await whatsappService.getCompanyStatus(companyId),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await whatsappService.logout(resolveWhatsappCompanyId(req as JwtRequest));
      res.json({ success: true, provider: whatsappService.provider });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chats', async (req: Request, res: Response, next: NextFunction) => {
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

  router.get('/messages/:chatId', requireChatTenantAccess, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const before = parseInt(String(req.query.before || '0'), 10);
      const messages = await whatsappService.getChatMessages(String(req.params.chatId), limit, before, companyId);
      res.json({ success: true, data: messages });
    } catch (error) {
      next(error);
    }
  });

  router.get('/templates', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const sync = String(req.query.sync || '').toLowerCase() === 'true';
      const templates = await whatsappService.listTemplates(companyId, { sync });
      res.json({
        success: true,
        data: templates,
      });
    } catch (error) {
      next(error);
    }
  });

  const sendMessage = legacyHumanSend(whatsappService, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const body = (req.body || {}) as Record<string, string>;
      const file = (req as any).file || null;
      const templateName = explicitTemplateName(body);
      const target = body.chatId || body.to;
      if (!target) {
        return res.status(400).json({ success: false, error: 'chatId o to es requerido' });
      }
      if (!body.message && !file && !templateName) {
        return res.status(400).json({ success: false, error: 'Mensaje, archivo o template requerido' });
      }

      const sent = await whatsappService.sendMessage(target, body.message || '', file, {
        templateName,
        templateLanguage: body.templateLanguage || body.language,
        companyId,
      });

      return res.json({
        success: true,
        data: {
          sentType: file ? 'media' : (templateName ? 'template' : 'text'),
          messageId: sent?.id?._serialized || sent?.id || null,
          timestamp: sent?.timestamp || Math.floor(Date.now() / 1000),
        },
      });
    } catch (error) {
      next(error);
    }
  }, { allowTemplates: true });
  router.post('/send-message', upload.single('file'), cleanRejectedUpload(requireChatTenantAccess), sendMessage);

  return router;
}

export default createWhatsAppRoutes;
