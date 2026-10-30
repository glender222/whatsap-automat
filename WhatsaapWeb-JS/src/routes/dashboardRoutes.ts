import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { DashboardRepositoryPg, DashboardService } from '../modules/dashboard';

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (req.user?.rol === 'ADMIN') return true;
  res.status(403).json({
    success: false,
    error: 'ADMIN_REQUIRED',
    message: 'Solo administradores pueden consultar el dashboard operativo.',
  });
  return false;
}

export default function createDashboardRoutes(): Router {
  const router = Router();
  const service = new DashboardService(new DashboardRepositoryPg(pool));

  router.use((req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    next();
  });

  router.get('/quick-stats', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getQuickStats(resolveWhatsappCompanyId(req));
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/action-cards', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getActionCards(resolveWhatsappCompanyId(req));
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/heatmap', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days || 7), 1), 30);
      const data = await service.getHeatmap(resolveWhatsappCompanyId(req), days);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sla-alerts', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const limit = parsePositiveInt(req.query.limit) || 20;
      const data = await service.getSlaAlerts(resolveWhatsappCompanyId(req), limit);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
