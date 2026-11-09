import { Router } from 'express';
import { JwtRequest, requireJwt, resolveWhatsappCompanyId, toPositiveInt } from '../middleware/jwtAuth';
import { auditLogger } from '../services/audit/AuditLogger';
import DiagnosticDoctor from '../services/diagnostics/DiagnosticDoctor';

function readDate(value: unknown, endOfDay = false): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return date.toISOString();
}

export default function createAdminRoutes(): Router {
  const router = Router();
  const doctor = new DiagnosticDoctor({ skipNetwork: true });
  let diagnostics: ReturnType<DiagnosticDoctor['runAll']> | undefined;

  router.use(requireJwt, (req: JwtRequest, res, next) => {
    const role = req.user?.rol ?? req.user?.role;
    if (typeof role !== 'string' || !['admin', 'owner'].includes(role.toLowerCase())) {
      return res.status(403).json({ success: false, error: 'POLICY_DENIED' });
    }
    next();
  });

  router.get('/audit-events', async (req: JwtRequest, res, next) => {
    try {
      const tenantId = resolveWhatsappCompanyId(req);
      const requestedTenant = req.query.tenantId;
      if (requestedTenant !== undefined && toPositiveInt(requestedTenant) !== tenantId) {
        return res.status(403).json({ success: false, error: 'POLICY_DENIED' });
      }

      const startDate = readDate(req.query.startDate);
      const endDate = readDate(req.query.endDate, true);
      if ((req.query.startDate && !startDate) || (req.query.endDate && !endDate) ||
          (startDate && endDate && startDate > endDate)) {
        return res.status(400).json({ success: false, error: 'INVALID_DATE_RANGE' });
      }

      const readFilter = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 100) : undefined;
      const limit = Math.min(toPositiveInt(req.query.limit) || 10, 100);
      const page = Math.min(toPositiveInt(req.query.page) || 1, 10000);
      const result = await auditLogger.query(tenantId, {
        action: readFilter(req.query.action),
        resourceType: readFilter(req.query.resourceType),
        search: readFilter(req.query.search),
        startDate,
        endDate,
        limit,
        offset: (page - 1) * limit,
      }, { requirePersisted: true });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/health/diagnostics', async (_req, res, next) => {
    try {
      diagnostics ??= doctor.runAll().finally(() => { diagnostics = undefined; });
      const report = await diagnostics;
      return res.json({
        ...report,
        checks: report.checks.map((check) => ({
          ...check,
          category: ['cache', 'disk', 'network'].includes(check.category) ? 'system' : check.category,
          details: { result: check.status },
          remediationGuide: check.remediationGuide || '',
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
