import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId, toPositiveInt } from '../middleware/jwtAuth';
import {
  createProblemDetails,
  StandardErrorCode,
  takeoverCommandV1Schema,
  pauseAiCommandV1Schema,
  resumeAiCommandV1Schema,
} from '@whatsap-automat/contracts';
import {
  ConversationCasService,
  conversationCasService,
  CasConflictError,
  ConversationNotFoundError,
} from '../services/conversations/ConversationCasService';

const STAGES = ['new', 'ai_assisting', 'catalog', 'preorder', 'handoff', 'payment', 'closed'];
const SUBSTATUSES = [
  'new',
  'intent_detected',
  'needs_clarification',
  'catalog_matched',
  'product_recommended',
  'quoted',
  'no_match',
  'out_of_stock',
  'preorder_open',
  'handoff_pending',
  'human_attending',
  'payment_pending',
  'voucher_received',
  'sale_confirmed',
  'completed',
  'lost_cancelled',
];

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function userId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id || req.user?.sub);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

export default function createConversationRoutes(
  casService: ConversationCasService = conversationCasService
): Router {
  const router = Router();

  router.get('/:id/timeline', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const conversationId = parsePositiveInt(req.params.id);
      if (!conversationId) return res.status(400).json({ success: false, message: 'Conversacion invalida' });

      const conversationResult = await pool.query(
        `SELECT id, external_conversation_id, title, status, commercial_stage, commercial_substatus,
                commercial_state_updated_at, service_window_expires_at
         FROM conversations
         WHERE company_id = $1 AND id = $2
         LIMIT 1`,
        [companyId, conversationId]
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) return res.status(404).json({ success: false, message: 'Conversacion no encontrada' });

      const chatId = conversation.external_conversation_id || null;
      const normalizedChatId = chatId ? String(chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '') : null;
      const limit = Math.max(20, Math.min(Number(req.query.limit || 150), 300));

      const [messages, actions, orders, handoffs, logs, payments] = await Promise.all([
        pool.query(
          `SELECT id, provider_message_id, direction, body, message_type, status, occurred_at,
                  EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.message_id = messages.id) AS has_attachments
           FROM messages
           WHERE company_id = $1 AND conversation_id = $2
           ORDER BY occurred_at DESC NULLS LAST, id DESC
           LIMIT $3`,
          [companyId, conversationId, limit]
        ),
        pool.query(
          `SELECT id, order_id, action_type, status, description, actor_user_id, metadata_json, occurred_at
           FROM operational_actions
           WHERE company_id = $1 AND conversation_id = $2
           ORDER BY occurred_at DESC, id DESC
           LIMIT $3`,
          [companyId, conversationId, limit]
        ),
        pool.query(
          `SELECT o.id, o.title, o.status, o.order_type, o.agent_id, o.created_by, o.occurred_at,
                  COALESCE(items.items_json, '[]'::jsonb) AS items_json
           FROM customer_orders o
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'id', oi.id,
               'commercialItemId', COALESCE(oi.commercial_item_id, oi.product_id),
               'productName', oi.product_name,
               'quantity', oi.quantity,
               'status', oi.status,
               'availabilityStatus', oi.availability_status
             ) ORDER BY oi.id) AS items_json
             FROM order_items oi
             WHERE oi.company_id = o.company_id AND oi.order_id = o.id
           ) items ON true
           WHERE o.company_id = $1 AND o.conversation_id = $2
           ORDER BY o.occurred_at DESC, o.id DESC
           LIMIT $3`,
          [companyId, conversationId, limit]
        ),
        pool.query(
          `SELECT id, agent_id, order_id, reason, priority, status, taken_by, closed_by, outcome, notes,
                  metadata_json, created_at, updated_at
           FROM handoff_tickets
           WHERE company_id = $1 AND conversation_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3`,
          [companyId, conversationId, limit]
        ),
        pool.query(
          `SELECT id, agent_id, stage, level, status, summary, action, tool_name,
                  tool_result_status, related_order_id, related_handoff_id, created_at
           FROM agent_runtime_logs
           WHERE company_id = $1
             AND ($2::varchar IS NULL OR chat_id = ANY($3::varchar[]))
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [companyId, normalizedChatId, [chatId, normalizedChatId].filter(Boolean), limit]
        ),
        pool.query(
          `SELECT id, order_id, status, amount, currency, file_url, gateway_payment_id,
                  payment_link_url, uploaded_by, validated_by, uploaded_at, validated_at, created_at
           FROM payment_vouchers
           WHERE company_id = $1 AND conversation_id = $2
           ORDER BY COALESCE(uploaded_at, created_at) DESC, id DESC
           LIMIT $3`,
          [companyId, conversationId, limit]
        ),
      ]);

      const events = [
        ...messages.rows.map((row) => ({
          id: `message:${row.id}`,
          type: 'message',
          occurredAt: row.occurred_at,
          title: row.direction === 'outbound' ? 'Mensaje enviado' : 'Mensaje recibido',
          summary: row.body || row.message_type || '',
          data: row,
        })),
        ...actions.rows.map((row) => ({
          id: `action:${row.id}`,
          type: 'action',
          occurredAt: row.occurred_at,
          title: row.action_type,
          summary: row.description || row.status,
          data: row,
        })),
        ...orders.rows.map((row) => ({
          id: `order:${row.id}`,
          type: 'order',
          occurredAt: row.occurred_at,
          title: row.title,
          summary: row.status,
          data: row,
        })),
        ...handoffs.rows.map((row) => ({
          id: `handoff:${row.id}`,
          type: 'handoff',
          occurredAt: row.created_at,
          title: `Handoff ${row.status}`,
          summary: row.reason,
          data: row,
        })),
        ...logs.rows.map((row) => ({
          id: `ai:${row.id}`,
          type: row.tool_name ? 'ai_tool' : 'ai_log',
          occurredAt: row.created_at,
          title: row.tool_name || row.stage,
          summary: row.summary || row.status,
          data: row,
        })),
        ...payments.rows.map((row) => ({
          id: `payment:${row.id}`,
          type: 'payment',
          occurredAt: row.uploaded_at || row.created_at,
          title: `Pago ${row.status}`,
          summary: row.amount ? `${row.currency || ''} ${row.amount}`.trim() : row.status,
          data: row,
        })),
      ].sort((a, b) => new Date(b.occurredAt || 0).getTime() - new Date(a.occurredAt || 0).getTime());

      return res.json({
        success: true,
        data: {
          conversation: {
            id: Number(conversation.id),
            chatId,
            title: conversation.title || null,
            status: conversation.status,
            commercialStage: conversation.commercial_stage || 'new',
            commercialSubstatus: conversation.commercial_substatus || 'new',
            commercialStateUpdatedAt: conversation.commercial_state_updated_at || null,
            serviceWindowExpiresAt: conversation.service_window_expires_at || null,
          },
          events: events.slice(0, limit),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/commercial-state', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const conversationId = parsePositiveInt(req.params.id);
      if (!conversationId) return res.status(400).json({ success: false, message: 'Conversacion invalida' });

      const stage = String(req.body?.stage || '');
      const substatus = String(req.body?.substatus || '');
      if (!STAGES.includes(stage) || !SUBSTATUSES.includes(substatus)) {
        return res.status(400).json({ success: false, message: 'Estado comercial invalido' });
      }

      const result = await pool.query(
        `UPDATE conversations
         SET commercial_stage = $3,
             commercial_substatus = $4,
             commercial_state_metadata_json = COALESCE($5::jsonb, commercial_state_metadata_json),
             commercial_state_updated_at = NOW(),
             updated_at = NOW()
         WHERE company_id = $1 AND id = $2
         RETURNING id, external_conversation_id, commercial_stage, commercial_substatus, commercial_state_updated_at`,
        [companyId, conversationId, stage, substatus, json(req.body?.metadata || {})]
      );
      if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Conversacion no encontrada' });

      await pool.query(
        `INSERT INTO operational_actions (
           company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
         )
         VALUES ($1, $2, $3, 'conversation_state_changed', 'completed', $4, $5::jsonb)`,
        [
          companyId,
          conversationId,
          userId(req),
          `Estado comercial actualizado a ${stage}/${substatus}`,
          json({ stage, substatus, source: 'manual', ...(req.body?.metadata || {}) }),
        ]
      );

      return res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      return next(error);
    }
  });

  // Helper to resolve correlationId from request headers
  function getCorrelationId(req: JwtRequest): string {
    return (
      (req.headers['x-correlation-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      `corr-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
    );
  }

  // CAS Route 1: POST /:id/takeover
  router.post('/:id/takeover', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const conversationId = parsePositiveInt(req.params.id);
      const correlationId = getCorrelationId(req);
      const instance = req.originalUrl || `/api/conversations/${req.params.id}/takeover`;

      if (!conversationId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: 'Invalid conversation id',
            instance,
            correlationId,
          })
        );
      }

      // Check tenant matching if provided in body
      if (req.body?.tenantId && toPositiveInt(req.body.tenantId) !== companyId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(403).json(
          createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            detail: 'Cross-tenant takeover denied by policy',
            instance,
            correlationId,
          })
        );
      }

      const activeUserId = userId(req) || toPositiveInt(req.body?.userId);
      if (!activeUserId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: 'Missing authenticated user ID for takeover',
            instance,
            correlationId,
          })
        );
      }

      const candidate = {
        schemaVersion: req.body?.schemaVersion ?? 1,
        tenantId: String(companyId),
        conversationId: String(conversationId),
        expectedVersion: req.body?.expectedVersion,
        userId: String(activeUserId),
        reason: req.body?.reason,
      };

      const parseResult = takeoverCommandV1Schema.safeParse(candidate);
      if (!parseResult.success) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
            instance,
            correlationId,
            invalidParams: parseResult.error.issues.map((i) => ({
              name: i.path.join('.'),
              reason: i.message,
            })),
          })
        );
      }

      const result = await casService.takeoverConversation({
        tenantId: companyId,
        conversationId,
        expectedVersion: parseResult.data.expectedVersion,
        userId: activeUserId,
        reason: parseResult.data.reason,
      });

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const correlationId = getCorrelationId(req);
      const instance = req.originalUrl || `/api/conversations/${req.params.id}/takeover`;

      if (error instanceof CasConflictError) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          createProblemDetails({
            code: StandardErrorCode.CONFLICT,
            detail: error.message,
            instance,
            correlationId,
            metadata: {
              conversationId: String(error.conversationId),
              expectedVersion: error.expectedVersion,
              currentVersion: error.currentVersion,
              currentEpoch: error.currentEpoch,
              ownerType: error.ownerType,
              ownerId: error.ownerId,
            },
          })
        );
      }

      if (error instanceof ConversationNotFoundError) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(404).json(
          createProblemDetails({
            code: StandardErrorCode.NOT_FOUND,
            detail: error.message,
            instance,
            correlationId,
            metadata: {
              conversationId: String(error.conversationId),
              tenantId: error.tenantId,
            },
          })
        );
      }

      return next(error);
    }
  });

  // CAS Route 2: POST /:id/pause-ai
  router.post('/:id/pause-ai', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const conversationId = parsePositiveInt(req.params.id);
      const correlationId = getCorrelationId(req);
      const instance = req.originalUrl || `/api/conversations/${req.params.id}/pause-ai`;

      if (!conversationId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: 'Invalid conversation id',
            instance,
            correlationId,
          })
        );
      }

      if (req.body?.tenantId && toPositiveInt(req.body.tenantId) !== companyId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(403).json(
          createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            detail: 'Cross-tenant pause-ai denied by policy',
            instance,
            correlationId,
          })
        );
      }

      const activeUserId = userId(req) || toPositiveInt(req.body?.userId);
      if (!activeUserId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: 'Missing authenticated user ID for pause-ai',
            instance,
            correlationId,
          })
        );
      }

      const candidate = {
        schemaVersion: req.body?.schemaVersion ?? 1,
        tenantId: String(companyId),
        conversationId: String(conversationId),
        expectedVersion: req.body?.expectedVersion,
        durationSeconds: req.body?.durationSeconds,
        reason: req.body?.reason,
      };

      const parseResult = pauseAiCommandV1Schema.safeParse(candidate);
      if (!parseResult.success) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
            instance,
            correlationId,
            invalidParams: parseResult.error.issues.map((i) => ({
              name: i.path.join('.'),
              reason: i.message,
            })),
          })
        );
      }

      const result = await casService.pauseAi({
        tenantId: companyId,
        conversationId,
        expectedVersion: parseResult.data.expectedVersion,
        userId: activeUserId,
        durationSeconds: parseResult.data.durationSeconds,
        reason: parseResult.data.reason,
      });

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const correlationId = getCorrelationId(req);
      const instance = req.originalUrl || `/api/conversations/${req.params.id}/pause-ai`;

      if (error instanceof CasConflictError) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          createProblemDetails({
            code: StandardErrorCode.CONFLICT,
            detail: error.message,
            instance,
            correlationId,
            metadata: {
              conversationId: String(error.conversationId),
              expectedVersion: error.expectedVersion,
              currentVersion: error.currentVersion,
              currentEpoch: error.currentEpoch,
            },
          })
        );
      }

      if (error instanceof ConversationNotFoundError) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(404).json(
          createProblemDetails({
            code: StandardErrorCode.NOT_FOUND,
            detail: error.message,
            instance,
            correlationId,
          })
        );
      }

      return next(error);
    }
  });

  // CAS Route 3: POST /:id/resume-ai
  router.post('/:id/resume-ai', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const conversationId = parsePositiveInt(req.params.id);
      const correlationId = getCorrelationId(req);
      const instance = req.originalUrl || `/api/conversations/${req.params.id}/resume-ai`;

      if (!conversationId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: 'Invalid conversation id',
            instance,
            correlationId,
          })
        );
      }

      if (req.body?.tenantId && toPositiveInt(req.body.tenantId) !== companyId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(403).json(
          createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            detail: 'Cross-tenant resume-ai denied by policy',
            instance,
            correlationId,
          })
        );
      }

      const activeUserId = userId(req) || toPositiveInt(req.body?.userId);
      if (!activeUserId) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: 'Missing authenticated user ID for resume-ai',
            instance,
            correlationId,
          })
        );
      }

      const candidate = {
        schemaVersion: req.body?.schemaVersion ?? 1,
        tenantId: String(companyId),
        conversationId: String(conversationId),
        expectedVersion: req.body?.expectedVersion,
        reason: req.body?.reason,
      };

      const parseResult = resumeAiCommandV1Schema.safeParse(candidate);
      if (!parseResult.success) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            detail: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
            instance,
            correlationId,
            invalidParams: parseResult.error.issues.map((i) => ({
              name: i.path.join('.'),
              reason: i.message,
            })),
          })
        );
      }

      const result = await casService.resumeAi({
        tenantId: companyId,
        conversationId,
        expectedVersion: parseResult.data.expectedVersion,
        userId: activeUserId,
        reason: parseResult.data.reason,
      });

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const correlationId = getCorrelationId(req);
      const instance = req.originalUrl || `/api/conversations/${req.params.id}/resume-ai`;

      if (error instanceof CasConflictError) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(409).json(
          createProblemDetails({
            code: StandardErrorCode.CONFLICT,
            detail: error.message,
            instance,
            correlationId,
            metadata: {
              conversationId: String(error.conversationId),
              expectedVersion: error.expectedVersion,
              currentVersion: error.currentVersion,
              currentEpoch: error.currentEpoch,
            },
          })
        );
      }

      if (error instanceof ConversationNotFoundError) {
        res.setHeader('Content-Type', 'application/problem+json');
        return res.status(404).json(
          createProblemDetails({
            code: StandardErrorCode.NOT_FOUND,
            detail: error.message,
            instance,
            correlationId,
          })
        );
      }

      return next(error);
    }
  });

  return router;
}
