import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { CommercialOrderStatus, OrderRepositoryPg, OrderService } from '../modules/orders';
import { emitDashboard } from '../sockets/socketEmitter';

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getUserId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export default function createOrderRoutes(): Router {
  const router = Router();
  const service = new OrderService(new OrderRepositoryPg(pool));

  router.get('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parsePositiveInt(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset || 0) || 0, 0);
      const data = await service.list(resolveWhatsappCompanyId(req), limit, offset);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Pedido invalido' });
      const data = await service.get(resolveWhatsappCompanyId(req), id);
      if (!data) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/detected', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.createDetected({
        companyId: resolveWhatsappCompanyId(req),
        chatId: String(req.body?.chatId || ''),
        userId: getUserId(req),
        agentId: req.body?.agentId ? Number(req.body.agentId) : null,
        items: req.body?.items || [],
        status: req.body?.status,
        notes: req.body?.notes || null,
        metadata: req.body?.metadata || {},
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/status', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Pedido invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const data = await service.updateStatus(
        companyId,
        id,
        String(req.body?.status || '') as CommercialOrderStatus,
        getUserId(req)
      );
      if (!data) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
      emitDashboard('order-status-changed', { companyId, orderId: data.id, status: data.status, chatId: data.metadata?.chatId || null });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/confirm', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Pedido invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const data = await service.updateStatus(companyId, id, 'confirmed', getUserId(req));
      if (!data) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
      emitDashboard('order-status-changed', { companyId, orderId: data.id, status: data.status, chatId: data.metadata?.chatId || null });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/cancel', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Pedido invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const data = await service.updateStatus(companyId, id, 'cancelled', getUserId(req));
      if (!data) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
      emitDashboard('order-status-changed', { companyId, orderId: data.id, status: data.status, chatId: data.metadata?.chatId || null });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
