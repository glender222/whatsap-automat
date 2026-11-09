import { Router, Request, Response } from 'express';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import { CampaignRequestError } from '../services/campaigns/CampaignRequestError';
import {
  createCampaignCommandV1Schema,
  recordConsentInputV1Schema,
  createSegmentCommandV1Schema,
  rightToBeForgottenCommandV1Schema,
  ChannelKind,
  ConsentPurpose,
  channelKindSchema,
  consentPurposeSchema,
} from '@whatsap-automat/contracts';
import {
  CampaignDispatcher,
  campaignDispatcher as defaultDispatcher,
} from '../services/campaigns/CampaignDispatcher';
import {
  ConsentService,
  consentService as defaultConsent,
} from '../services/campaigns/ConsentService';
import {
  SegmentationService,
  segmentationService as defaultSegments,
} from '../services/campaigns/SegmentationService';

function resolveTenantId(req: Request): number {
  const id = req.tenantId ?? req.tenantContext?.tenantId ?? req.whatsappCompanyId;
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new CampaignRequestError(401, 'UNAUTHORIZED', 'La operación requiere una empresa.');
  }
  return Number(id);
}

function respondError(res: Response, error: unknown) {
  if (error instanceof CampaignRequestError) {
    return res.status(error.statusCode).json({ success: false, error: error.code, message: error.message });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Revisa los campos enviados.' });
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    return res.status(409).json({ success: false, error: 'ALREADY_EXISTS', message: 'Ya existe un registro con esos datos.' });
  }
  return res.status(503).json({
    success: false,
    error: 'CAMPAIGN_SERVICE_UNAVAILABLE',
    message: 'La operación no pudo confirmarse. Vuelve a consultar antes de reintentar.',
  });
}

export interface CampaignRoutesOptions {
  dispatcher?: CampaignDispatcher;
  consent?: ConsentService;
  segments?: SegmentationService;
}

export function createCampaignRoutes(options: CampaignRoutesOptions = {}): Router {
  const router = Router();
  const dispatcher = options.dispatcher || defaultDispatcher;

  // 1. POST /api/v1/campaigns - Create a new broadcast campaign
  router.post('/', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = createCampaignCommandV1Schema.parse(req.body);
      const campaign = await dispatcher.createCampaign(tenantId, parsed);
      res.status(201).json({ success: true, data: campaign });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 2. GET /api/v1/campaigns - List campaigns for tenant
  router.get('/', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const campaigns = await dispatcher.listCampaigns(tenantId);
      res.status(200).json({ success: true, data: campaigns });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 3. GET /api/v1/campaigns/:id - Get campaign details
  router.get('/:id', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const campaignId = String(req.params.id);
      const campaign = await dispatcher.getCampaign(tenantId, campaignId);
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Campaign not found' });
      }
      res.status(200).json({ success: true, data: campaign });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 4. POST /api/v1/campaigns/:id/dispatch - Execute campaign broadcast
  router.post('/:id/dispatch', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const campaignId = String(req.params.id);
      const campaign = await dispatcher.executeCampaign(tenantId, campaignId, req.body?.recipients);
      res.status(200).json({ success: true, data: campaign });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 5. GET /api/v1/campaigns/:id/deliveries - Get deliveries audit list
  router.get('/:id/deliveries', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const campaignId = String(req.params.id);
      const campaign = await dispatcher.getCampaign(tenantId, campaignId);
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Campaign not found' });
      }
      const deliveries = await dispatcher.getDeliveries(campaignId, tenantId);
      res.status(200).json({ success: true, data: deliveries });
    } catch (error) {
      respondError(res, error);
    }
  });

  return router;
}

export function createConsentRoutes(options: CampaignRoutesOptions = {}): Router {
  const router = Router();
  const consent = options.consent || defaultConsent;

  // 1. POST /api/v1/consent - Record or update opt-in / opt-out
  router.post('/', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = recordConsentInputV1Schema.parse(req.body);
      const record = await consent.recordConsent(tenantId, parsed);
      res.status(201).json({ success: true, data: record });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 2. GET /api/v1/consent - List consent records
  router.get('/', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const records = await consent.listConsentRecords(tenantId, {
        channelType: req.query.channelType as ChannelKind,
        destination: req.query.destination as string,
        purpose: req.query.purpose as ConsentPurpose,
      });
      res.status(200).json({ success: true, data: records });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 3. POST /api/v1/consent/verify - Pre-dispatch consent check
  router.post('/verify', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const { channel, destination, purpose = 'marketing' } = req.body ?? {};
      if (!channel || typeof destination !== 'string' || !destination.trim()) {
        return res.status(400).json({ success: false, error: 'BAD_REQUEST', message: 'channel and destination are required' });
      }
      const result = await consent.verifyConsent(tenantId, channelKindSchema.parse(channel), destination, consentPurposeSchema.parse(purpose));
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 4. POST /api/v1/consent/right-to-be-forgotten - GDPR RTBF
  router.post('/right-to-be-forgotten', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = rightToBeForgottenCommandV1Schema.parse(req.body);
      const result = await consent.executeRightToBeForgotten(tenantId, parsed.customerId, parsed.destination);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      respondError(res, error);
    }
  });

  return router;
}

export function createSegmentRoutes(options: CampaignRoutesOptions = {}): Router {
  const router = Router();
  const segments = options.segments || defaultSegments;

  // 1. POST /api/v1/segments - Create audience segment
  router.post('/', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = createSegmentCommandV1Schema.parse(req.body);
      const segment = await segments.createSegment(tenantId, parsed);
      res.status(201).json({ success: true, data: segment });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 2. GET /api/v1/segments - List audience segments
  router.get('/', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const list = await segments.listSegments(tenantId);
      res.status(200).json({ success: true, data: list });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 3. GET /api/v1/segments/:id - Get segment details
  router.get('/:id', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const segmentId = String(req.params.id);
      const segment = await segments.getSegment(tenantId, segmentId);
      if (!segment) {
        return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Segment not found' });
      }
      res.status(200).json({ success: true, data: segment });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 4. POST /api/v1/segments/:id/calculate - Calculate audience count
  router.post('/:id/calculate', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const segmentId = String(req.params.id);
      const count = await segments.evaluateSegmentCount(tenantId, segmentId);
      res.status(200).json({ success: true, data: { segmentId, count } });
    } catch (error) {
      respondError(res, error);
    }
  });

  // 5. GET /api/v1/segments/:id/recipients - Resolve recipients
  router.get('/:id/recipients', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const segmentId = String(req.params.id);
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new CampaignRequestError(400, 'INVALID_PAGINATION', 'La paginación solicitada no es válida.');
      }
      const recipients = await segments.resolveRecipients(tenantId, segmentId, limit, offset);
      res.status(200).json({ success: true, data: recipients });
    } catch (error) {
      respondError(res, error);
    }
  });

  return router;
}

export default function createUnifiedCampaignRoutes(options: CampaignRoutesOptions = {}): Router {
  const router = Router();
  router.use('/campaigns', createCampaignRoutes(options));
  router.use('/consent', createConsentRoutes(options));
  router.use('/segments', createSegmentRoutes(options));
  return router;
}
