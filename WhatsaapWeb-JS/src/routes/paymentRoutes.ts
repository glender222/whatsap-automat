import { NextFunction, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import pool from '../config/database';
import config from '../config/index';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';
import { PaymentRepositoryPg, PaymentService } from '../modules/payments';
import { emitDashboard, emitToRoom } from '../sockets/socketEmitter';

const multer = require('multer') as any;

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getUserId(req: JwtRequest): number | null {
  const value = Number(req.user?.userId || req.user?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (req.user?.rol === 'ADMIN') return true;
  res.status(403).json({
    success: false,
    error: 'ADMIN_REQUIRED',
    message: 'Solo administradores pueden gestionar comprobantes de pago.',
  });
  return false;
}

const ALLOWED_MIME = /^(image\/(jpeg|png|webp|gif)|application\/pdf|video\/mp4)$/i;

export default function createPaymentRoutes(): Router {
  const router = Router();
  const service = new PaymentService(new PaymentRepositoryPg(pool));
  const mediaDir = path.join(config.whatsapp.uploadDir, 'payment-vouchers');
  fs.mkdirSync(mediaDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req: any, _file: any, cb: any) => cb(null, mediaDir),
      filename: (_req: any, file: any, cb: any) => {
        const ext = extensionFromMime(file.mimetype, file.originalname);
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
      },
    }),
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      if (!ALLOWED_MIME.test(String(file.mimetype || ''))) {
        return cb(validationError('Solo se permiten imagenes, PDF o MP4'));
      }
      return cb(null, true);
    },
  });

  router.use((req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    next();
  });

  router.get('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.list(resolveWhatsappCompanyId(req), {
        status: req.query.status ? String(req.query.status) as any : undefined,
        paymentMethod: req.query.paymentMethod ? String(req.query.paymentMethod) as any : undefined,
        orderId: parsePositiveInt(req.query.orderId) || undefined,
        chatId: req.query.chatId ? String(req.query.chatId) : undefined,
        startDate: req.query.startDate ? String(req.query.startDate) : undefined,
        endDate: req.query.endDate ? String(req.query.endDate) : undefined,
        limit: parsePositiveInt(req.query.limit) || 50,
        offset: Math.max(Number(req.query.offset || 0) || 0, 0),
      });
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/pending/count', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const count = await service.countPending(resolveWhatsappCompanyId(req));
      res.json({ success: true, data: { count } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', upload.single('file'), async (req: JwtRequest & { file?: any }, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ success: false, message: 'Archivo de comprobante requerido' });
      const companyId = resolveWhatsappCompanyId(req);
      const voucher = await service.create({
        companyId,
        orderId: parsePositiveInt(req.body.orderId) || null,
        chatId: req.body.chatId ? String(req.body.chatId) : null,
        contactId: parsePositiveInt(req.body.contactId) || null,
        conversationId: parsePositiveInt(req.body.conversationId) || null,
        sourceMessageId: parsePositiveInt(req.body.sourceMessageId) || null,
        fileUrl: `/uploads/payment-vouchers/${file.filename}`,
        mimeType: file.mimetype,
        fileSize: file.size,
        paymentMethod: String(req.body.paymentMethod || 'other') as any,
        amount: req.body.amount !== undefined && req.body.amount !== '' ? Number(req.body.amount) : null,
        currency: req.body.currency || 'PEN',
        senderReference: req.body.senderReference ? String(req.body.senderReference) : null,
        uploadedBy: getUserId(req),
        notes: req.body.notes ? String(req.body.notes) : null,
        metadata: { origin: 'manual_upload', originalName: file.originalname },
      });
      emitDashboard('payment-created', { companyId, voucherId: voucher.id, chatId: voucher.chatId });
      if (voucher.chatId) emitToRoom(voucher.chatId, 'payment-created', { voucherId: voucher.id });
      return res.status(201).json({ success: true, data: voucher });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/from-message', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const messageId = parsePositiveInt(req.body.messageId);
      if (!messageId) return res.status(400).json({ success: false, message: 'messageId requerido' });
      const companyId = resolveWhatsappCompanyId(req);
      const voucher = await service.markFromMessage({
        companyId,
        messageId,
        chatId: req.body.chatId ? String(req.body.chatId) : null,
        orderId: parsePositiveInt(req.body.orderId) || null,
        paymentMethod: String(req.body.paymentMethod || 'other') as any,
        amount: req.body.amount !== undefined && req.body.amount !== '' ? Number(req.body.amount) : null,
        currency: req.body.currency || 'PEN',
        senderReference: req.body.senderReference ? String(req.body.senderReference) : null,
        uploadedBy: getUserId(req),
        notes: req.body.notes ? String(req.body.notes) : null,
      });
      emitDashboard('payment-created', { companyId, voucherId: voucher.id, chatId: voucher.chatId });
      if (voucher.chatId) emitToRoom(voucher.chatId, 'payment-created', { voucherId: voucher.id });
      return res.status(201).json({ success: true, data: voucher });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Comprobante invalido' });
      const data = await service.get(resolveWhatsappCompanyId(req), id);
      if (!data) return res.status(404).json({ success: false, message: 'Comprobante no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/validate', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Comprobante invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const data = await service.validate(companyId, id, getUserId(req));
      if (!data) return res.status(404).json({ success: false, message: 'Comprobante no encontrado' });
      emitDashboard('payment-updated', { companyId, voucherId: data.id, status: data.status, chatId: data.chatId });
      if (data.chatId) emitToRoom(data.chatId, 'payment-updated', { voucherId: data.id, status: data.status });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/reject', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Comprobante invalido' });
      const companyId = resolveWhatsappCompanyId(req);
      const data = await service.reject(
        companyId,
        id,
        getUserId(req),
        req.body?.rejectionReason ? String(req.body.rejectionReason) : null
      );
      if (!data) return res.status(404).json({ success: false, message: 'Comprobante no encontrado' });
      emitDashboard('payment-updated', { companyId, voucherId: data.id, status: data.status, chatId: data.chatId });
      if (data.chatId) emitToRoom(data.chatId, 'payment-updated', { voucherId: data.id, status: data.status });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function extensionFromMime(mimeType: string | null | undefined, filename: string | null | undefined): string {
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.mp4'].includes(ext)) return ext;
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
  };
  return map[String(mimeType || '').toLowerCase()] || '.bin';
}

function validationError(message: string): Error & { statusCode?: number; code?: string } {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}
