import { Router, Request, Response, NextFunction } from 'express';
import WhatsAppService from '../services/whatsappService';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';

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

  router.get('/qr', (_req: Request, res: Response) => {
    res.json({ qr: whatsappService.getQR() || null, provider: whatsappService.provider });
  });

  router.get('/me', (_req: Request, res: Response) => {
    const info = whatsappService.getMyInfo();
    if (!info) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp no configurado o no disponible',
      });
    }
    return res.json(info);
  });

  router.post('/init', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await whatsappService.initialize();
      res.json({
        success: true,
        provider: whatsappService.provider,
        status: whatsappService.getStatus(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await whatsappService.logout();
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

  router.get('/messages/:chatId', async (req: Request, res: Response, next: NextFunction) => {
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

  router.post('/send-message', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req as JwtRequest);
      const body = req.body as Record<string, string>;
      const target = body.chatId || body.to;
      if (!target) {
        return res.status(400).json({ success: false, error: 'chatId o to es requerido' });
      }
      if (!body.message && !(req as any).file && !body.templateName && !body.template) {
        return res.status(400).json({ success: false, error: 'Mensaje, archivo o template requerido' });
      }

      const sent = await whatsappService.sendMessage(target, body.message || '', (req as any).file || null, {
        templateName: body.templateName || body.template,
        templateLanguage: body.templateLanguage || body.language,
        companyId,
      });

      return res.json({
        success: true,
        data: {
          sentType: (req as any).file ? 'media' : (body.templateName || body.template ? 'template' : 'text'),
          messageId: sent?.id?._serialized || sent?.id || null,
          timestamp: sent?.timestamp || Math.floor(Date.now() / 1000),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createWhatsAppRoutes;
