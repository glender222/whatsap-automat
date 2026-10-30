import { Router, Request, Response, NextFunction } from 'express';
import WhatsAppService from '../services/whatsappService';
import config from '../config/index';

type RawBodyRequest = Request & { rawBody?: Buffer };

export function createMetaWebhookRoutes(whatsappService: WhatsAppService): Router {
  if (config.whatsapp.provider === 'meta-cloud' && !config.meta.appSecret) {
    throw new Error('META_APP_SECRET es obligatorio cuando WHATSAPP_PROVIDER=meta-cloud');
  }

  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const verifyToken = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verified = whatsappService.verifyMetaWebhook(mode, verifyToken, challenge);
    if (verified !== null) {
      return res.status(200).send(String(verified));
    }

    return res.status(403).json({
      success: false,
      error: 'Webhook verify token invalido',
    });
  });

  router.post('/', async (req: RawBodyRequest, res: Response, next: NextFunction) => {
    try {
      if (config.whatsapp.provider === 'meta-cloud') {
        const validSignature = Boolean(whatsappService.metaClient?.verifySignature(
          req.rawBody,
          req.headers['x-hub-signature-256']
        ));
        if (!validSignature) {
          return res.status(403).json({
            success: false,
            error: 'Firma de Meta invalida',
          });
        }
      }

      const result = await whatsappService.handleMetaWebhook(req.body);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createMetaWebhookRoutes;
