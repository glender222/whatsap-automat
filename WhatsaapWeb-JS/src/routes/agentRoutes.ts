import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response, Router } from 'express';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import AgentService from '../services/ai/AgentService';

const multer = require('multer') as any;

function toInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('ID invalido');
  return parsed;
}

function userId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (req.user?.rol === 'ADMIN') return true;
  res.status(403).json({
    success: false,
    error: 'ADMIN_REQUIRED',
    message: 'Solo administradores pueden gestionar la configuracion del agente IA.',
  });
  return false;
}

const VALID_MODES = ['normal', 'mixed', 'automator'];
const VALID_HANDOFF_OUTCOMES = ['sale_confirmed', 'no_sale', 'follow_up_required', 'support_resolved', 'duplicate', 'cancelled'];
const VALID_DOMAIN_KEYS = ['gestion_web', 'inventory_stock', 'commercial_catalog', 'orders', 'support', 'payments'];

export default function createAgentRoutes(): Router {
  const router = Router();
  const service = new AgentService();
  const knowledgeUploadDir = path.join(config.whatsapp.uploadDir, 'agent-knowledge');
  fs.mkdirSync(knowledgeUploadDir, { recursive: true });
  const upload = multer({ dest: knowledgeUploadDir, limits: { fileSize: config.multer.maxFileSize } });

  router.get('/domains', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const domains = await service.listDomains(resolveWhatsappCompanyId(req));
      res.json({ success: true, data: domains });
    } catch (error) { next(error); }
  });

  router.post('/domains/:domainKey/activate', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const domainKey = String(req.params.domainKey || '');
      if (!VALID_DOMAIN_KEYS.includes(domainKey)) {
        return res.status(400).json({ success: false, message: 'Dominio IA invalido' });
      }
      const domain = await service.activateDomain(resolveWhatsappCompanyId(req), domainKey);
      return res.json({ success: true, data: domain });
    } catch (error) { return next(error); }
  });

  router.put('/domains/:domainKey/agent', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const domainKey = String(req.params.domainKey || '');
      if (!VALID_DOMAIN_KEYS.includes(domainKey)) {
        return res.status(400).json({ success: false, message: 'Dominio IA invalido' });
      }
      const rawAgentId = req.body?.agentId;
      const agentId = rawAgentId === null ? null : Number(rawAgentId);
      if (agentId !== null && (!Number.isInteger(agentId) || agentId <= 0)) {
        return res.status(400).json({ success: false, message: 'agentId requerido' });
      }
      const domain = await service.assignDomainAgent(resolveWhatsappCompanyId(req), domainKey, agentId);
      return res.json({ success: true, data: domain });
    } catch (error) { return next(error); }
  });

  router.post('/domains/:domainKey/deploy', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const domainKey = String(req.params.domainKey || '');
      if (domainKey !== 'gestion_web') {
        return res.status(400).json({ success: false, message: 'En v1 solo gestion_web permite Deploy AI runtime' });
      }
      const agentId = toInt(req.body?.agentId);
      const domain = await service.deployDomainAgent(resolveWhatsappCompanyId(req), domainKey, agentId, req.body?.patch || undefined);
      return res.json({ success: true, data: domain });
    } catch (error) { return next(error); }
  });

  router.get('/domains/:domainKey/activity', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const domainKey = String(req.params.domainKey || '');
      if (!VALID_DOMAIN_KEYS.includes(domainKey)) {
        return res.status(400).json({ success: false, message: 'Dominio IA invalido' });
      }
      const activity = await service.listDomainActivity(resolveWhatsappCompanyId(req), domainKey, {
        agentId: req.query.agentId ? Number(req.query.agentId) : null,
        status: req.query.status ? String(req.query.status) : null,
        tool: req.query.tool ? String(req.query.tool) : null,
        chatId: req.query.chatId ? String(req.query.chatId) : null,
        dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : null,
        dateTo: req.query.dateTo ? String(req.query.dateTo) : null,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      return res.json({ success: true, data: activity });
    } catch (error) { return next(error); }
  });

  router.get('/domains/:domainKey/operations', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const domainKey = String(req.params.domainKey || '');
      if (!VALID_DOMAIN_KEYS.includes(domainKey)) {
        return res.status(400).json({ success: false, message: 'Dominio IA invalido' });
      }
      const activity = await service.listDomainActivity(resolveWhatsappCompanyId(req), domainKey, {
        agentId: req.query.agentId ? Number(req.query.agentId) : null,
        status: req.query.status ? String(req.query.status) : null,
        tool: req.query.tool ? String(req.query.tool) : null,
        chatId: req.query.chatId ? String(req.query.chatId) : null,
        dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : null,
        dateTo: req.query.dateTo ? String(req.query.dateTo) : null,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      return res.json({ success: true, data: activity });
    } catch (error) { return next(error); }
  });

  router.get('/domains/:domainKey/sessions', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const domainKey = String(req.params.domainKey || '');
      if (!VALID_DOMAIN_KEYS.includes(domainKey)) {
        return res.status(400).json({ success: false, message: 'Dominio IA invalido' });
      }
      const sessions = await service.listDomainSessions(
        resolveWhatsappCompanyId(req),
        domainKey,
        req.query.limit ? Number(req.query.limit) : 100
      );
      return res.json({ success: true, data: sessions });
    } catch (error) { return next(error); }
  });

  router.get('/domains/:domainKey/metrics', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const domainKey = String(req.params.domainKey || '');
      if (!VALID_DOMAIN_KEYS.includes(domainKey)) {
        return res.status(400).json({ success: false, message: 'Dominio IA invalido' });
      }
      const metrics = await service.getDomainMetrics(resolveWhatsappCompanyId(req), domainKey);
      return res.json({ success: true, data: metrics });
    } catch (error) { return next(error); }
  });

  router.get('/company-mode', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const mode = await service.getAutomatorMode(resolveWhatsappCompanyId(req));
      res.json({ success: true, data: { mode } });
    } catch (error) { next(error); }
  });

  router.put('/company-mode', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const mode = String(req.body?.mode || '');
      if (!VALID_MODES.includes(mode)) {
        return res.status(400).json({ success: false, message: 'Modo invalido. Usa normal, mixed o automator.' });
      }
      await service.setAutomatorMode(resolveWhatsappCompanyId(req), mode as any);
      return res.json({ success: true, data: { mode } });
    } catch (error) { return next(error); }
  });

  router.get('/handoff-tickets', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.listHandoffTickets(resolveWhatsappCompanyId(req), {
        status: req.query.status ? String(req.query.status) : undefined,
        conversationId: req.query.conversationId ? Number(req.query.conversationId) : undefined,
        takenBy: req.query.takenBy ? Number(req.query.takenBy) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      });
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  router.post('/handoff-tickets/:id/take', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const ticket = await service.takeHandoffTicket(resolveWhatsappCompanyId(req), toInt(req.params.id), userId(req) || 0);
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket no encontrado o ya tomado' });
      return res.json({ success: true, data: ticket });
    } catch (error) { return next(error); }
  });

  router.post('/handoff-tickets/:id/close', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!VALID_HANDOFF_OUTCOMES.includes(String(req.body?.outcome || ''))) {
        return res.status(400).json({ success: false, message: 'Resultado de cierre requerido' });
      }
      const ticket = await service.closeHandoffTicket(
        resolveWhatsappCompanyId(req),
        toInt(req.params.id),
        userId(req) || 0,
        {
          notes: req.body?.notes ? String(req.body.notes) : null,
          outcome: String(req.body.outcome) as any,
        }
      );
      if (!ticket) return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
      return res.json({ success: true, data: ticket });
    } catch (error) { return next(error); }
  });

  router.get('/payment-gateways', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await service.listGateways(resolveWhatsappCompanyId(req));
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  router.post('/payment-gateways', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await service.createGateway(resolveWhatsappCompanyId(req), req.body || {});
      res.status(201).json({ success: true, data });
    } catch (error) { next(error); }
  });

  router.patch('/payment-gateways/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await service.updateGateway(resolveWhatsappCompanyId(req), toInt(req.params.id), req.body || {});
      if (!data) return res.status(404).json({ success: false, message: 'Pasarela no encontrada' });
      return res.json({ success: true, data });
    } catch (error) { return next(error); }
  });

  router.delete('/payment-gateways/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      await service.archiveGateway(resolveWhatsappCompanyId(req), toInt(req.params.id));
      res.json({ success: true, message: 'Pasarela archivada' });
    } catch (error) { next(error); }
  });

  router.get('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const agents = await service.listAgents(resolveWhatsappCompanyId(req));
      res.json({ success: true, data: agents });
    } catch (error) { next(error); }
  });

  router.post('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agent = await service.createAgent(resolveWhatsappCompanyId(req), userId(req), req.body || {});
      res.status(200).json({ success: true, data: agent });
    } catch (error) { next(error); }
  });

  router.get('/provider/status', async (_req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: service.getProviderStatus() });
    } catch (error) { next(error); }
  });

  router.get('/provider/models', async (_req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await service.listProviderModels() });
    } catch (error) { next(error); }
  });

  router.post('/provider/test', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await service.testProvider({ model: req.body?.model || null }) });
    } catch (error) { next(error); }
  });

  router.post('/suggest/default', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const agent = await service.getDefaultActiveAgent(companyId, req.body?.message || '');
      if (!agent) return res.status(404).json({ success: false, error: 'No hay agente activo para esta empresa' });
      const result = await service.runAgent(
        companyId,
        Number(agent.id),
        { message: req.body?.message || '', history: req.body?.history || [], chatId: req.body?.chatId, mode: 'suggest' },
        userId(req)
      );
      return res.json({ success: true, data: { ...result, agentId: agent.id } });
    } catch (error) { return next(error); }
  });

  router.get('/runtime-logs', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const logs = await service.listRuntimeLogs(resolveWhatsappCompanyId(req), {
        chatId: req.query.chatId ? String(req.query.chatId) : null,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        status: req.query.status ? String(req.query.status) : undefined,
        action: req.query.action ? String(req.query.action) : undefined,
      });
      return res.json({ success: true, data: logs });
    } catch (error) { return next(error); }
  });

  router.get('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const agent = await service.getAgent(resolveWhatsappCompanyId(req), toInt(req.params.id));
      res.json({ success: true, data: agent });
    } catch (error) { next(error); }
  });

  router.put('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agent = await service.updateAgent(resolveWhatsappCompanyId(req), toInt(req.params.id), req.body || {});
      res.json({ success: true, data: agent });
    } catch (error) { next(error); }
  });

  router.delete('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      await service.archiveAgent(resolveWhatsappCompanyId(req), toInt(req.params.id));
      res.json({ success: true, message: 'Agente archivado' });
    } catch (error) { next(error); }
  });

  router.put('/:id/profile', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agent = await service.updateProfile(resolveWhatsappCompanyId(req), toInt(req.params.id), req.body || {});
      res.json({ success: true, data: agent });
    } catch (error) { next(error); }
  });

  router.put('/:id/rules', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const agent = await service.updateRules(resolveWhatsappCompanyId(req), toInt(req.params.id), req.body || {});
      res.json({ success: true, data: agent });
    } catch (error) { next(error); }
  });

  router.post('/:id/knowledge', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const source = await service.createKnowledge(resolveWhatsappCompanyId(req), toInt(req.params.id), req.body || {});
      res.status(200).json({ success: true, data: source });
    } catch (error) { next(error); }
  });

  router.post('/:id/knowledge/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    const jwtReq = req as JwtRequest;
    if (!requireAdmin(jwtReq, res)) return;
    try {
      const file = (req as Request & { file?: any }).file;
      if (!file) return res.status(400).json({ success: false, error: 'Archivo requerido' });
      const source = await service.createKnowledgeFromFile(resolveWhatsappCompanyId(jwtReq), toInt(req.params.id), file, req.body || {});
      return res.status(200).json({ success: true, data: source });
    } catch (error) { return next(error); }
  });

  router.put('/:id/knowledge/:sourceId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const source = await service.updateKnowledge(resolveWhatsappCompanyId(req), toInt(req.params.id), toInt(req.params.sourceId), req.body || {});
      res.json({ success: true, data: source });
    } catch (error) { next(error); }
  });

  router.delete('/:id/knowledge/:sourceId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      await service.deleteKnowledge(resolveWhatsappCompanyId(req), toInt(req.params.id), toInt(req.params.sourceId));
      res.json({ success: true, message: 'Fuente eliminada' });
    } catch (error) { next(error); }
  });

  router.get('/:id/knowledge/:sourceId/file', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const file = await service.getKnowledgeFile(resolveWhatsappCompanyId(req), toInt(req.params.id), toInt(req.params.sourceId));
      res.setHeader('Content-Type', file.mimeType);
      return res.download(file.filePath, file.filename);
    } catch (error) { return next(error); }
  });

  router.post('/:id/test', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const result = await service.runAgent(
        resolveWhatsappCompanyId(req),
        toInt(req.params.id),
        { message: req.body?.message || '', history: req.body?.history || [], mode: req.body?.mode },
        userId(req)
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  });

  router.post('/:id/test-session', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const result = await service.runAgentTestSession(
        resolveWhatsappCompanyId(req),
        toInt(req.params.id),
        {
          message: req.body?.message || '',
          history: Array.isArray(req.body?.history) ? req.body.history : [],
          domainKey: 'gestion_web',
        },
        userId(req)
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  });

  router.post('/:id/suggest', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const result = await service.runAgent(
        resolveWhatsappCompanyId(req),
        toInt(req.params.id),
        { message: req.body?.message || '', history: req.body?.history || [], chatId: req.body?.chatId, mode: 'suggest' },
        userId(req)
      );
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  });

  return router;
}
