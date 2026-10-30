import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { ReportFilters, ReportRepositoryPg, ReportService } from '../modules/reports';

const DEFAULT_TIMEZONE = 'America/Lima';
const MAX_RANGE_DAYS = 366;

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function dateDaysAgo(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function parseDate(value: unknown, fallback: string): string {
  const text = String(value || fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw createRequestError('Fecha invalida. Usa formato YYYY-MM-DD.');
  }
  return text;
}

function parseTimezone(value: unknown): string {
  const timezone = String(value || DEFAULT_TIMEZONE);
  try {
    new Intl.DateTimeFormat('es-PE', { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw createRequestError('Zona horaria invalida.');
  }
}

function createRequestError(message: string): Error & { statusCode?: number; code?: string } {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function parseFilters(req: JwtRequest, options: { exportMode?: boolean } = {}): ReportFilters {
  const timezone = parseTimezone(req.query.timezone);
  const today = todayInTimezone(timezone);
  const startDate = parseDate(req.query.startDate, dateDaysAgo(today, 29));
  const endDate = parseDate(req.query.endDate, today);
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const days = Math.floor((end - start) / 86_400_000) + 1;

  if (end < start) throw createRequestError('La fecha final no puede ser anterior a la fecha inicial.');
  if (days > MAX_RANGE_DAYS) throw createRequestError(`El rango maximo es de ${MAX_RANGE_DAYS} dias.`);

  const maxLimit = options.exportMode ? 5000 : 200;
  return {
    startDate,
    endDate,
    timezone,
    tagId: parsePositiveInt(req.query.tagId),
    actorUserId: parsePositiveInt(req.query.actorUserId),
    status: req.query.status ? String(req.query.status).trim() : undefined,
    limit: Math.min(parsePositiveInt(req.query.limit) || (options.exportMode ? 5000 : 50), maxLimit),
    offset: Math.max(Number(req.query.offset || 0) || 0, 0),
  };
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (req.user?.rol === 'ADMIN') return true;
  res.status(403).json({
    success: false,
    error: 'ADMIN_REQUIRED',
    message: 'Solo administradores pueden consultar reportes.',
  });
  return false;
}

export default function createReportRoutes(): Router {
  const router = Router();
  const service = new ReportService(new ReportRepositoryPg(pool));

  router.use((req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    next();
  });

  router.get('/metrics', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const filters = parseFilters(req);
      const data = await service.getMetrics(resolveWhatsappCompanyId(req), filters);
      res.json({ success: true, data, filters });
    } catch (error) {
      next(error);
    }
  });

  router.get('/stats', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const filters = parseFilters(req);
      const metrics = await service.getMetrics(resolveWhatsappCompanyId(req), filters);
      const peakDay = [...metrics.messagesByDay].sort((a, b) => b.count - a.count)[0] || null;
      res.json({
        success: true,
        data: {
          period: { start: filters.startDate, end: filters.endDate, timezone: filters.timezone },
          totalMessages: metrics.totalMessages,
          averageDaily: metrics.messagesByDay.length
            ? Math.round(metrics.totalMessages / metrics.messagesByDay.length)
            : 0,
          peakDay,
          messagesByDay: metrics.messagesByDay,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/operations', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const filters = parseFilters(req);
      const data = await service.getOperationalReport(resolveWhatsappCompanyId(req), filters);
      res.json({ success: true, data, filters });
    } catch (error) {
      next(error);
    }
  });

  router.get('/operations/export', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const format = String(req.query.format || 'csv').toLowerCase();
      if (!['csv', 'xls'].includes(format)) {
        return res.status(400).json({ success: false, message: 'Formato invalido. Usa csv o xls.' });
      }

      const filters = parseFilters(req, { exportMode: true });
      const exported = await service.getOperationalExport(
        resolveWhatsappCompanyId(req),
        filters,
        format as 'csv' | 'xls'
      );
      res.setHeader('Content-Type', exported.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
      res.send(exported.content);
    } catch (error) {
      next(error);
    }
  });

  router.get('/heatmap', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const filters = parseFilters(req);
      const data = await service.getHeatmap(resolveWhatsappCompanyId(req), filters);
      res.json({ success: true, data, filters });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chat/:chatId/history', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const chatId = String(req.params.chatId || '').trim();
      if (!chatId) return res.status(400).json({ success: false, message: 'Chat invalido' });

      const data = await service.getChatHistory(
        resolveWhatsappCompanyId(req),
        chatId,
        Math.min(parsePositiveInt(req.query.limit) || 1000, 5000)
      );
      if (!data) return res.status(404).json({ success: false, message: 'Chat no encontrado' });

      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
