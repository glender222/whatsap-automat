import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { withTenantTransaction } from '../db/TenantScopedUoW';
import { normalizeChatIdCandidates } from '../middleware/resourceAuth';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { AgentPauseService, IaPauseOverrideRepositoryPg } from '../modules/ai';
import AgentService from '../services/ai/AgentService';

function getUserId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function resolveConversationId(chatId: string, companyId: number): Promise<number> {
  const result = await withTenantTransaction(companyId, (client) => client.query(
    `SELECT id FROM conversations
     WHERE company_id = $1 AND channel = 'whatsapp'
       AND external_conversation_id = ANY($2::varchar[])
     ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 1`,
    [companyId, normalizeChatIdCandidates(chatId)]
  ));
  if (!result.rows[0]?.id) {
    const error = new Error('Conversacion no encontrada') as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  return Number(result.rows[0].id);
}

export default function createIaPauseRoutes(): Router {
  const router = Router();
  const service = new AgentPauseService(new IaPauseOverrideRepositoryPg(pool));
  const agentService = new AgentService();

  router.get('/:chatId/status', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const conversationId = await resolveConversationId(String(req.params.chatId), companyId);
      const status = await service.getStatus(companyId, conversationId);
      return res.json({ success: true, data: status });
    } catch (error) { return next(error); }
  });

  router.post('/:chatId/pause', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const chatId = String(req.params.chatId);
      const conversationId = await resolveConversationId(chatId, companyId);
      const override = await agentService.pauseConversation({
        companyId,
        conversationId,
        chatId,
        pausedBy: getUserId(req),
        reason: req.body?.reason ? String(req.body.reason) : null,
        durationHours: req.body?.durationHours ? Number(req.body.durationHours) : undefined,
      });
      return res.json({ success: true, data: override });
    } catch (error) { return next(error); }
  });

  router.post('/:chatId/resume', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const chatId = String(req.params.chatId);
      const conversationId = await resolveConversationId(chatId, companyId);
      await agentService.resumeConversation(companyId, conversationId, chatId);
      return res.json({ success: true, message: 'IA reanudada en este chat' });
    } catch (error) { return next(error); }
  });

  return router;
}
