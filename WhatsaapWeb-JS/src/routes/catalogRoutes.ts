import { NextFunction, Response, Router } from 'express';
import type { Pool } from 'pg';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId, toPositiveInt } from '../middleware/jwtAuth';
import { CatalogRepositoryPg, CatalogService } from '../modules/inventory';

function parsePositiveInt(value: unknown): number | null {
  const parsed = toPositiveInt(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (req.user?.rol === 'ADMIN') return true;
  res.status(403).json({
    success: false,
    error: 'ADMIN_REQUIRED',
    message: 'Solo administradores pueden gestionar catalogos.',
  });
  return false;
}

export default function createCatalogRoutes(database: Pool = pool): Router {
  const router = Router();
  const service = new CatalogService(new CatalogRepositoryPg(database));

  router.get('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.list(resolveWhatsappCompanyId(req));
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await service.create(resolveWhatsappCompanyId(req), req.body || {});
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Catalogo invalido' });
      const data = await service.update(resolveWhatsappCompanyId(req), id, req.body || {});
      if (!data) return res.status(404).json({ success: false, message: 'Catalogo no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/status', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Catalogo invalido' });
      const data = await service.setStatus(resolveWhatsappCompanyId(req), id, String(req.body?.status || ''));
      if (!data) return res.status(404).json({ success: false, message: 'Catalogo no encontrado' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/items', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parsePositiveInt(req.params.id);
      const commercialItemId = parsePositiveInt(req.body?.commercialItemId);
      const requestedSection = req.body?.sectionId;
      const sectionId = requestedSection == null ? null : parsePositiveInt(requestedSection);
      if (!id || !commercialItemId || (requestedSection != null && sectionId === null)) return res.status(400).json({ success: false, message: 'Catalogo o item invalido' });
      const added = await service.addItem(resolveWhatsappCompanyId(req), id, commercialItemId, sectionId);
      return res.status(added ? 201 : 200).json({ success: true, data: { added } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id/sections', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Catalogo invalido' });
      const data = await service.listSections(resolveWhatsappCompanyId(req), id);
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/sections', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Catalogo invalido' });
      const data = await service.createSection(resolveWhatsappCompanyId(req), id, req.body || {});
      if (!data) return res.status(404).json({ success: false, message: 'Catalogo no encontrado' });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/sections/:sectionId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const sectionId = parsePositiveInt(req.params.sectionId);
      if (!sectionId) return res.status(400).json({ success: false, message: 'Seccion invalida' });
      const data = await service.updateSection(resolveWhatsappCompanyId(req), sectionId, req.body || {});
      if (!data) return res.status(404).json({ success: false, message: 'Seccion no encontrada' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/sections/:sectionId/status', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const sectionId = parsePositiveInt(req.params.sectionId);
      if (!sectionId) return res.status(400).json({ success: false, message: 'Seccion invalida' });
      const data = await service.setSectionStatus(resolveWhatsappCompanyId(req), sectionId, String(req.body?.status || ''));
      if (!data) return res.status(404).json({ success: false, message: 'Seccion no encontrada' });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id/items/:commercialItemId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parsePositiveInt(req.params.id);
      const commercialItemId = parsePositiveInt(req.params.commercialItemId);
      if (!id || !commercialItemId) return res.status(400).json({ success: false, message: 'Catalogo o item invalido' });
      const removed = await service.removeItem(resolveWhatsappCompanyId(req), id, commercialItemId);
      return res.json({ success: true, data: { removed } });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
