import { NextFunction, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import pool from '../config/database';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { ProductRepositoryPg, ProductService, type ProductInput } from '../modules/inventory';
import { DashboardRepositoryPg } from '../modules/dashboard';
import { emitDashboard } from '../sockets/socketEmitter';

const multer = require('multer') as any;

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getUserId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function getBooleanQuery(value: unknown): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (req.user?.rol === 'ADMIN') return true;
  res.status(403).json({
    success: false,
    error: 'ADMIN_REQUIRED',
    message: 'Solo administradores pueden gestionar el catalogo comercial.',
  });
  return false;
}

function isAdmin(req: JwtRequest): boolean {
  return req.user?.rol === 'ADMIN';
}

function sanitizeProductInputForRole(req: JwtRequest, input: Record<string, any>, currentStatus?: string | null): Record<string, any> {
  if (isAdmin(req)) return input;
  const allowed: Record<string, true> = {
    name: true,
    description: true,
    sku: true,
    price: true,
    priceMode: true,
    currency: true,
    itemType: true,
    unitLabel: true,
    availabilityType: true,
    capacity: true,
    allowBackorder: true,
    reservationTtlMinutes: true,
    stockAvailable: true,
    catalogIds: true,
    catalogAssignments: true,
    imageUrl: true,
    imageAltText: true,
    images: true,
    metadata: true,
  };
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (allowed[key]) sanitized[key] = value;
  }
  sanitized.status = currentStatus || 'draft';
  sanitized.aiEnabled = false;
  return sanitized;
}

export default function createProductRoutes(): Router {
  const router = Router();
  const service = new ProductService(new ProductRepositoryPg(pool));
  const dashboardRepo = new DashboardRepositoryPg(pool);
  const mediaDir = path.join(config.whatsapp.uploadDir, 'commercial-items');
  fs.mkdirSync(mediaDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req: any, _file: any, cb: any) => cb(null, mediaDir),
      filename: (_req: any, file: any, cb: any) => {
        const ext = extensionFromMime(file.mimetype, file.originalname);
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      if (!/^image\/(jpeg|png|webp|gif)$/i.test(String(file.mimetype || ''))) {
        return cb(validationError('Solo se permiten imagenes JPG, PNG, WEBP o GIF'));
      }
      return cb(null, true);
    },
  });

  router.get('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.list(resolveWhatsappCompanyId(req), {
        q: String(req.query.q || ''),
        catalogId: parsePositiveInt(req.query.catalogId),
        type: req.query.type ? String(req.query.type) as any : null,
        status: req.query.status ? String(req.query.status) as any : null,
        aiEnabled: getBooleanQuery(req.query.aiEnabled),
        sectionId: parsePositiveInt(req.query.sectionId),
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/low-stock', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const data = await dashboardRepo.getLowStock(
        companyId,
        parsePositiveInt(req.query.limit) || 50,
        Math.max(Number(req.query.offset || 0) || 0, 0)
      );
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const input = sanitizeProductInputForRole(req, req.body || {});
      if (String(input.status || '') === 'active' && !input.imageUrl && (!Array.isArray(input.images) || input.images.length === 0)) {
        return res.status(400).json({ success: false, message: 'La oferta necesita una imagen principal antes de publicarse' });
      }
      const data = await service.create(resolveWhatsappCompanyId(req), input as ProductInput);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/media', upload.single('file'), async (req: JwtRequest & { file?: any }, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ success: false, message: 'Imagen requerida' });
      return res.status(201).json({
        success: true,
        data: {
          imageUrl: `/uploads/commercial-items/${file.filename}`,
          imageAltText: req.body?.altText || file.originalname || null,
          filename: file.filename,
          mimeType: file.mimetype,
          size: file.size,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const data = await service.get(resolveWhatsappCompanyId(req), id);
      if (!data) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const current = await service.get(companyId, id);
      if (!current) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      const nextInput = sanitizeProductInputForRole(req, req.body || {}, current.status);
      if (String(nextInput.status || current.status) === 'active' && !(req.body?.imageUrl || current.primaryImage?.url || current.imageUrl)) {
        return res.status(400).json({ success: false, message: 'La oferta necesita una imagen principal antes de publicarse' });
      }
      const data = await service.update(companyId, id, nextInput);
      if (!data) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/status', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const current = await service.get(companyId, id);
      if (!current) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      if (String(req.body?.status || '') === 'active' && !current.primaryImage?.url && !current.imageUrl) {
        return res.status(400).json({ success: false, message: 'La oferta necesita una imagen principal antes de publicarse' });
      }
      const data = await service.update(companyId, id, { status: req.body?.status });
      if (!data) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id/availability', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const item = (await service.list(resolveWhatsappCompanyId(req))).find((entry) => entry.id === id);
      if (!item) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      return res.json({
        success: true,
        data: {
          commercialItemId: item.id,
          availabilityType: item.availabilityType,
          availableQuantity: item.stockAvailable,
          reservedQuantity: item.stockReserved,
          capacity: item.capacity,
          allowBackorder: item.allowBackorder,
          reservationTtlMinutes: item.reservationTtlMinutes,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/availability', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const data = await service.update(resolveWhatsappCompanyId(req), id, {
        availabilityType: req.body?.availabilityType,
        stockAvailable: req.body?.availableQuantity ?? req.body?.stockAvailable,
        capacity: req.body?.capacity,
        allowBackorder: req.body?.allowBackorder,
        reservationTtlMinutes: req.body?.reservationTtlMinutes,
      });
      if (!data) return res.status(404).json({ success: false, message: 'Item de catalogo no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/images', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const data = await service.addImage(companyId, id, {
        imageUrl: String(req.body?.imageUrl || '').trim(),
        imageAltText: req.body?.imageAltText || req.body?.altText || null,
        sortOrder: req.body?.sortOrder,
        isPrimary: req.body?.isPrimary === true,
        mimeType: req.body?.mimeType || null,
        sizeBytes: req.body?.sizeBytes ?? null,
      });
      if (!data) return res.status(400).json({ success: false, message: 'No se pudo agregar la imagen. Verifica el item o el limite de 8 imagenes.' });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/images/:imageId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const imageId = parsePositiveInt(req.params.imageId);
      if (!id || !imageId) return res.status(400).json({ success: false, message: 'Imagen invalida' });
      const data = await service.updateImage(resolveWhatsappCompanyId(req), id, imageId, {
        imageUrl: req.body?.imageUrl ? String(req.body.imageUrl).trim() : undefined,
        imageAltText: req.body?.imageAltText ?? req.body?.altText,
        sortOrder: req.body?.sortOrder,
        isPrimary: req.body?.isPrimary,
        mimeType: req.body?.mimeType,
        sizeBytes: req.body?.sizeBytes,
      });
      if (!data) return res.status(404).json({ success: false, message: 'Imagen no encontrada' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id/images/:imageId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const imageId = parsePositiveInt(req.params.imageId);
      if (!id || !imageId) return res.status(400).json({ success: false, message: 'Imagen invalida' });
      const removed = await service.deleteImage(resolveWhatsappCompanyId(req), id, imageId);
      return res.json({ success: true, data: { removed } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/stock-adjustments', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const result = await service.adjustStock(companyId, id, {
        delta: Number(req.body?.delta),
        notes: req.body?.notes || null,
        actorUserId: getUserId(req),
      });
      if (!result) return res.status(400).json({ success: false, message: 'Item no encontrado o disponibilidad insuficiente' });
      emitDashboard('stock-updated', { companyId, productId: result.product.id, stockAvailable: result.product.stockAvailable, stockReserved: result.product.stockReserved });
      return res.json({ success: true, data: result.product });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/availability-movements', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Item de catalogo invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const result = await service.adjustStock(companyId, id, {
        delta: Number(req.body?.deltaAvailable ?? req.body?.delta),
        notes: req.body?.reason || req.body?.notes || null,
        actorUserId: getUserId(req),
      });
      if (!result) return res.status(400).json({ success: false, message: 'Item no encontrado o disponibilidad insuficiente' });
      emitDashboard('stock-updated', { companyId, productId: result.product.id, stockAvailable: result.product.stockAvailable, stockReserved: result.product.stockReserved });
      return res.json({ success: true, data: result.product });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function extensionFromMime(mimeType: string | null | undefined, filename: string | null | undefined): string {
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[String(mimeType || '').toLowerCase()] || '.jpg';
}

function validationError(message: string): Error & { statusCode?: number; code?: string } {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}
