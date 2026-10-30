import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import {
  CustomerHistoryNotFoundError,
  CustomerHistoryRepositoryPg,
  CustomerHistoryService,
} from '../modules/customerHistory';

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default function createCustomerHistoryRoutes(): Router {
  const router = Router();
  const service = new CustomerHistoryService(new CustomerHistoryRepositoryPg(pool));

  router.get('/contacts/:contactId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const contactId = parsePositiveInt(req.params.contactId);
      if (!contactId) {
        return res.status(400).json({ success: false, message: 'Contacto invalido' });
      }

      const data = await service.getByContactId(resolveWhatsappCompanyId(req), contactId, {
        conversationLimit: parsePositiveInt(req.query.conversationLimit),
        messageLimit: parsePositiveInt(req.query.messageLimit),
      });

      return res.json({ success: true, data });
    } catch (error) {
      return handleCustomerHistoryError(error, res, next);
    }
  });

  router.get('/chats/:chatId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const chatId = String(req.params.chatId || '').trim();
      if (!chatId) {
        return res.status(400).json({ success: false, message: 'Chat invalido' });
      }

      const data = await service.getByChatId(resolveWhatsappCompanyId(req), chatId, {
        conversationLimit: parsePositiveInt(req.query.conversationLimit),
        messageLimit: parsePositiveInt(req.query.messageLimit),
      });

      return res.json({ success: true, data });
    } catch (error) {
      return handleCustomerHistoryError(error, res, next);
    }
  });

  return router;
}

function handleCustomerHistoryError(error: unknown, res: Response, next: NextFunction): void | Response {
  if (error instanceof CustomerHistoryNotFoundError) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.code,
      message: error.message,
    });
  }
  return next(error);
}
