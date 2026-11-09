import { randomUUID } from 'node:crypto';
import { Router, Response } from 'express';
import {
  channelKindSchema,
  commercialStageSchema,
  conversationStatusSchema,
  createProblemDetails,
  StandardErrorCode,
} from '@whatsap-automat/contracts';
import { JwtRequest, requireJwt, resolveWhatsappCompanyId, toPositiveInt } from '../middleware/jwtAuth';
import { isInternalChatId } from '../middleware/resourceAuth';
import { tenantContext } from '../middleware/tenantContext';
import { ConversationQueryService, conversationQueryService, parseConversationPage } from '../services/conversations/ConversationQueryService';
import {
  CasConflictError, ConversationNotFoundError, conversationCasService,
} from '../services/conversations/ConversationCasService';
import {
  ConversationSendError, ConversationSendService, conversationSendService,
} from '../services/conversations/ConversationSendService';

const requestKeyPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

function problem(
  req: JwtRequest, res: Response, code: StandardErrorCode, detail: string, metadata?: Record<string, unknown>,
) {
  const body = createProblemDetails({ code, detail, instance: req.originalUrl, correlationId: randomUUID(), metadata });
  return res.status(body.status).type('application/problem+json').json(body);
}

export default function createConversationV1Routes(
  sender: ConversationSendService = conversationSendService,
  query: ConversationQueryService = conversationQueryService,
): Router {
  const router = Router();
  router.use(requireJwt, tenantContext({ allowSandbox: false }));

  router.get('/', async (req: JwtRequest, res, next) => {
    try {
      const page = parseConversationPage(req.query, 20);
      const channel = channelKindSchema.optional().safeParse(req.query.channel);
      const stage = commercialStageSchema.optional().safeParse(req.query.stage);
      const status = conversationStatusSchema.optional().safeParse(req.query.status);
      if (!page || !channel.success || !stage.success || !status.success) {
        return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Invalid conversation filters or cursor');
      }
      const tenantId = resolveWhatsappCompanyId(req);
      return res.json(await query.list(tenantId, page, {
        channel: channel.data, stage: stage.data, status: status.data,
      }));
    } catch (error) { return next(error); }
  });

  router.get('/:id', async (req: JwtRequest, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isInternalChatId(id)) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
      const item = await query.get(resolveWhatsappCompanyId(req), Number(id));
      if (!item) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
      return res.json(item);
    } catch (error) { return next(error); }
  });

  router.get('/:id/messages', async (req: JwtRequest, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isInternalChatId(id)) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
      const page = parseConversationPage(req.query, 50);
      if (!page) return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Invalid message cursor or page size');
      const key = req.query.clientRequestId;
      if (key !== undefined && (typeof key !== 'string' || !requestKeyPattern.test(key))) {
        return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Invalid client request ID');
      }
      const result = await query.messages(resolveWhatsappCompanyId(req), Number(id), page, key);
      if (!result) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.post('/:id/messages', async (req: JwtRequest, res, next) => {
    const id = String(req.params.id);
    if (!isInternalChatId(id)) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
    const actor = req.tenantContext;
    if (!actor?.userId || actor.userId > 2147483647 || actor.tenantId > 2147483647 ||
        !['ADMIN', 'EMPLEADO', 'SUPERADMIN'].includes(actor.role ?? '')) {
      return problem(req, res, StandardErrorCode.POLICY_DENIED, 'A signed operator identity is required');
    }
    const key = req.get('Idempotency-Key');
    const body = req.body;
    const version = body?.expectedConversationVersion;
    const message = body?.message;
    if (!key || !requestKeyPattern.test(key) ||
        !Number.isSafeInteger(version) || version < 0 || version >= 2147483647 ||
        !message || typeof message !== 'object' || typeof message.kind !== 'string') {
      return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Provide an idempotency key, expected conversation version and message');
    }
    if (message.kind !== 'text') {
      return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Only plain text messages are supported',
        { reasonCode: 'MESSAGE_KIND_UNSUPPORTED' });
    }
    const text = message.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(text) ||
        Object.keys(body).some((name) => name !== 'message' && name !== 'expectedConversationVersion') ||
        Object.keys(message).some((name) => name !== 'kind' && name !== 'text')) {
      return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Invalid plain text message payload');
    }

    try {
      const result = await sender.send({
        tenantId: actor.tenantId, actorId: actor.userId, conversationId: Number(id), expectedVersion: version, key, text,
      });
      return res.setHeader('Cache-Control', 'no-store').status(202).json(result);
    } catch (error) {
      if (error instanceof ConversationSendError) {
        return problem(req, res, error.code, error.message, { reasonCode: error.reasonCode, ...error.metadata });
      }
      return next(new Error('The conversation message could not be prepared.'));
    }
  });

  const commands = {
    takeover: conversationCasService.takeoverConversation.bind(conversationCasService),
    'pause-ai': conversationCasService.pauseAi.bind(conversationCasService),
    'resume-ai': conversationCasService.resumeAi.bind(conversationCasService),
  } as const;

  for (const [action, execute] of Object.entries(commands)) {
    router.post(`/:id/${action}`, async (req: JwtRequest, res, next) => {
      try {
        const id = String(req.params.id);
        if (!isInternalChatId(id)) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
        const tenantId = resolveWhatsappCompanyId(req);
        const userId = toPositiveInt(req.user?.userId ?? req.user?.id ?? req.user?.sub);
        const { expectedVersion, durationSeconds, reason } = req.body ?? {};
        if (!userId) return problem(req, res, StandardErrorCode.POLICY_DENIED, 'A signed user identity is required');
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483647 ||
            (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) ||
            (durationSeconds !== undefined && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 2147483647))) {
          return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Invalid expected version, reason or duration');
        }
        const { conversation } = await execute({
          tenantId, conversationId: Number(id), userId, expectedVersion, reason, durationSeconds, includeConversation: true,
        });
        return res.json(conversation);
      } catch (error) {
        if (error instanceof ConversationNotFoundError) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Conversation not found');
        if (error instanceof CasConflictError) {
          const body = createProblemDetails({
            code: StandardErrorCode.CONFLICT,
            detail: 'Conversation version changed', instance: req.originalUrl, correlationId: randomUUID(),
            metadata: { expectedVersion: error.expectedVersion, currentVersion: error.currentVersion },
          });
          return res.status(409).type('application/problem+json').json(body);
        }
        return next(error);
      }
    });
  }

  return router;
}
