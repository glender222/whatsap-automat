import { Router, Request, Response } from 'express';
import {
  marketplaceSearchQuerySchema,
  extensionRatingScoreSchema,
} from '@whatsap-automat/contracts';
import { MarketplaceRegistry } from '../services/marketplace/MarketplaceRegistry';

export function createMarketplaceRoutes(registry?: MarketplaceRegistry): Router {
  const router = Router();
  const service = registry || new MarketplaceRegistry();

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
  router.post('/extensions', async (req: Request, res: Response) => {
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

      const tarballBuffer = tarballBase64 ? Buffer.from(tarballBase64, 'base64') : undefined;

      const registered = await service.registerExtension({
        manifest,
        tarballBuffer,
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
  router.post('/extensions/:id/rate', (req: Request, res: Response) => {
    try {
      const { score, review } = req.body || {};
      const validatedScore = extensionRatingScoreSchema.parse(score);

      const tenantId = (req as any).user?.company_id || (req as any).tenantId || req.headers['x-tenant-id'] || '1';
      const userId = (req as any).user?.id || (req as any).userId || req.headers['x-user-id'] || 'agent_anon';

      const result = service.submitRating({
        extensionId: String(req.params.id),
        tenantId: String(tenantId),
        userId: String(userId),
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

  // GET /api/v1/marketplace/extensions/:id/ratings - List ratings
  router.get('/extensions/:id/ratings', (req: Request, res: Response) => {
    const ratings = service.getRatings(String(req.params.id));
    return res.json({
      success: true,
      data: ratings,
    });
  });

  // POST /api/v1/marketplace/validate - Dry-run validation
  router.post('/validate', (req: Request, res: Response) => {
    const { manifest, tarballBase64, expectedSha256 } = req.body || {};
    const tarballBuffer = tarballBase64 ? Buffer.from(tarballBase64, 'base64') : undefined;

    const report = service.validateManifest(manifest, tarballBuffer, expectedSha256);
    return res.json({
      success: report.valid,
      data: report,
    });
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
