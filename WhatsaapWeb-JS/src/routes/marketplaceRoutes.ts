import { Router, Request, Response } from 'express';
import {
  marketplaceSearchQuerySchema,
  extensionRatingScoreSchema,
} from '@whatsap-automat/contracts';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import { MarketplaceRegistry } from '../services/marketplace/MarketplaceRegistry';

function resolveActor(req: Request, res: Response) {
  const context = req.tenantContext;
  if (context?.userId) {
    return { tenantId: context.tenantId, userId: context.userId, role: context.role };
  }
  res.status(403).json({
    type: 'https://whatsap-automat.internal/errors/ACTOR_REQUIRED',
    title: 'User Identity Required',
    status: 403,
  });
  return null;
}

function readArchive(value: unknown): Buffer | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('tarballBase64 must be a base64 string.');
  const archive = Buffer.from(value, 'base64');
  const canonical = archive.toString('base64');
  if (!archive.length || (value !== canonical && value !== canonical.replace(/=+$/, ''))) {
    throw new Error('tarballBase64 must contain a valid base64 archive.');
  }
  return archive;
}

export function createMarketplaceRoutes(registry?: MarketplaceRegistry): Router {
  const router = Router();
  const service = registry || new MarketplaceRegistry();
  const authenticatedTenant = [requireJwt, tenantContext({ allowSandbox: false })];

  // GET /api/v1/marketplace/extensions - Catalog search & listing
  router.get('/extensions', (req: Request, res: Response) => {
    try {
      const query = marketplaceSearchQuerySchema.parse(req.query);
      const result = service.listExtensions(query);
      return res.json({
        success: true,
        data: result.items,
        pagination: {
          total: result.total,
          limit: query.limit,
          offset: query.offset,
        },
      });
    } catch (err: any) {
      return res.status(400).json({
        type: 'https://whatsap-automat.internal/errors/INVALID_QUERY',
        title: 'Invalid Marketplace Query',
        status: 400,
        detail: err.message,
      });
    }
  });

  // GET /api/v1/marketplace/extensions/:id - Detail view
  router.get('/extensions/:id', (req: Request, res: Response) => {
    const extId = String(req.params.id);
    const listing = service.getExtension(extId);
    if (!listing) {
      return res.status(404).json({
        type: 'https://whatsap-automat.internal/errors/EXTENSION_NOT_FOUND',
        title: 'Extension Not Found',
        status: 404,
        detail: `No extension found with id "${extId}"`,
      });
    }
    return res.json({
      success: true,
      data: listing,
    });
  });

  // POST /api/v1/marketplace/extensions - Register / publish extension
  router.post('/extensions', ...authenticatedTenant, async (req: Request, res: Response) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    if (actor.role !== 'ADMIN') {
      return res.status(403).json({
        type: 'https://whatsap-automat.internal/errors/ADMIN_REQUIRED',
        title: 'Administrator Role Required',
        status: 403,
      });
    }
    try {
      const {
        manifest,
        tarballBase64,
        expectedSha256,
        tarballUrl,
        displayName,
        longDescription,
        categories,
        tags,
      } = req.body || {};

      const registered = await service.registerExtension({
        publisherTenantId: actor.tenantId,
        manifest,
        tarballBuffer: readArchive(tarballBase64),
        expectedSha256,
        tarballUrl,
        displayName,
        longDescription,
        categories,
        tags,
      });

      return res.status(201).json({
        success: true,
        data: registered,
      });
    } catch (err: any) {
      const status = err.statusCode || 400;
      return res.status(status).json({
        type: 'https://whatsap-automat.internal/errors/EXTENSION_REGISTRATION_FAILED',
        title: 'Extension Registration Failed',
        status,
        detail: err.message,
        errors: err.errors || [err.message],
      });
    }
  });

  // POST /api/v1/marketplace/extensions/:id/rate - Submit rating
  router.post('/extensions/:id/rate', ...authenticatedTenant, (req: Request, res: Response) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      const { score, review } = req.body || {};
      const validatedScore = extensionRatingScoreSchema.parse(score);

      const result = service.submitRating({
        extensionId: String(req.params.id),
        tenantId: String(actor.tenantId),
        userId: String(actor.userId),
        score: validatedScore,
        review,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err.statusCode || 400;
      return res.status(status).json({
        type: 'https://whatsap-automat.internal/errors/RATING_SUBMISSION_FAILED',
        title: 'Rating Submission Failed',
        status,
        detail: err.message,
      });
    }
  });

  // GET /api/v1/marketplace/extensions/:id/ratings - List ratings for the authenticated tenant
  router.get('/extensions/:id/ratings', ...authenticatedTenant, (req: Request, res: Response) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    const ratings = service.getRatings(String(req.params.id), String(actor.tenantId));
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      success: true,
      data: ratings,
    });
  });

  // POST /api/v1/marketplace/validate - Dry-run validation
  router.post('/validate', (req: Request, res: Response) => {
    try {
      const { manifest, tarballBase64, expectedSha256 } = req.body || {};
      const report = service.validateManifest(manifest, readArchive(tarballBase64), expectedSha256);
      return res.json({
        success: report.valid,
        data: report,
      });
    } catch {
      return res.status(400).json({
        type: 'https://whatsap-automat.internal/errors/INVALID_ARCHIVE',
        title: 'Invalid Archive Input',
        status: 400,
      });
    }
  });

  // GET /api/v1/marketplace/health - Health check
  router.get('/health', (_req: Request, res: Response) => {
    return res.json({
      status: 'ok',
      service: 'marketplace-registry',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
