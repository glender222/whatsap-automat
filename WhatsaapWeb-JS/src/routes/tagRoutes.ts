import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { queryInTenantScope } from '../db/TenantScopedUoW';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';

type TagRow = Record<string, any>;

function chatLookupValues(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const value = input.trim();
  if (!value || value.length > 255) return [];
  const phone = /^\+?([\d ()-]+)(?:@c\.us|@s\.whatsapp\.net)?$/.exec(value);
  const digits = phone?.[1].replace(/\D/g, '');
  return digits ? [...new Set([value, digits, `${digits}@c.us`, `${digits}@s.whatsapp.net`])] : [value];
}

function normalizeTag(row: TagRow): Record<string, unknown> {
  return {
    id: String(row.id),
    name: row.name,
    color: row.color || null,
    owner_id: row.created_by ? String(row.created_by) : null,
    is_default: Boolean(row.is_default),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    chat_count: Number(row.chat_count || 0),
    employee_count: Number(row.employee_count || 0),
  };
}

function isAdmin(req: JwtRequest): boolean {
  return req.user?.rol === 'ADMIN';
}

function requireAdmin(req: JwtRequest, res: Response): boolean {
  if (isAdmin(req)) return true;
  res.status(403).json({
    success: false,
    error: 'Solo administradores pueden gestionar etiquetas',
  });
  return false;
}

function parseTagId(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

async function ensureDefaultTag(companyId: number): Promise<void> {
  await queryInTenantScope(pool, companyId,
    `INSERT INTO tags (company_id, name, color, is_default)
     VALUES ($1, 'Todo', 'text-green-500', TRUE)
     ON CONFLICT DO NOTHING`,
    [companyId]
  );
}

async function findTag(companyId: number, tagId: number): Promise<TagRow | null> {
  const result = await queryInTenantScope(pool, companyId,
    `SELECT t.*,
            COUNT(DISTINCT tc.chat_id) FILTER (WHERE NOT t.is_default) AS chat_count,
            COUNT(DISTINCT tu.user_id) AS employee_count
     FROM tags t
     LEFT JOIN tag_chats tc ON tc.company_id = t.company_id AND tc.tag_id = t.id
     LEFT JOIN tag_users tu ON tu.company_id = t.company_id AND tu.tag_id = t.id
     WHERE t.company_id = $1 AND t.id = $2
     GROUP BY t.id`,
    [companyId, tagId]
  );
  return result.rows[0] || null;
}

async function listChatsForCompany(companyId: number, tagId?: number): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [companyId];
  let tagFilter = '';

  if (tagId) {
    params.push(tagId);
    tagFilter = `AND EXISTS (
      SELECT 1 FROM tag_chats tc
      WHERE tc.company_id = c.company_id
        AND tc.tag_id = $2
        AND (tc.conversation_id = c.id OR (tc.conversation_id IS NULL AND tc.chat_id = c.external_conversation_id))
    )`;
  }

  const result = await queryInTenantScope(pool, companyId,
    `SELECT
       c.external_conversation_id AS id,
       c.id AS conversation_id,
       COALESCE(c.title, ct.display_name, ct.name, ct.profile_name, ct.phone, c.external_conversation_id) AS name,
       c.last_message_at,
       c.unread_count,
       c.last_message_preview,
       c.status,
       c.service_window_expires_at
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
     WHERE c.company_id = $1
       AND c.channel = 'whatsapp'
       AND c.archived_at IS NULL
       ${tagFilter}
     ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
     LIMIT 200`,
    params
  );

  return result.rows.map((row) => ({
    id: row.id,
    conversationId: String(row.conversation_id),
    name: row.name,
    lastMessageTimestamp: row.last_message_at ? Math.floor(new Date(row.last_message_at).getTime() / 1000) : null,
    unreadCount: row.unread_count || 0,
    isGroup: false,
    lastMessagePreview: row.last_message_preview || null,
    status: row.status,
    serviceWindowExpiresAt: row.service_window_expires_at,
  }));
}

export default function createTagRoutes(): Router {
  const router = Router();

  router.get('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      await ensureDefaultTag(companyId);

      const result = await queryInTenantScope(pool, companyId,
        `SELECT t.*,
                COUNT(DISTINCT tc.chat_id) FILTER (WHERE NOT t.is_default) AS chat_count,
                COUNT(DISTINCT tu.user_id) AS employee_count
         FROM tags t
         LEFT JOIN tag_chats tc ON tc.company_id = t.company_id AND tc.tag_id = t.id
         LEFT JOIN tag_users tu ON tu.company_id = t.company_id AND tu.tag_id = t.id
         WHERE t.company_id = $1
         GROUP BY t.id
         ORDER BY t.is_default DESC, LOWER(t.name) ASC`,
        [companyId]
      );

      res.json({
        success: true,
        data: result.rows.map(normalizeTag),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const name = String(req.body?.name || '').trim();
      const color = req.body?.color ? String(req.body.color).trim() : null;

      if (!name || name.length > 80 || (color && color.length > 80)) {
        return res.status(400).json({ success: false, message: 'Usa un nombre de etiqueta y un color de hasta 80 caracteres' });
      }

      await ensureDefaultTag(companyId);
      const result = await queryInTenantScope(pool, companyId,
        `INSERT INTO tags (company_id, name, color, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [companyId, name, color, req.user?.userId || null]
      );

      res.status(200).json({
        success: true,
        data: normalizeTag(result.rows[0]),
      });
    } catch (error: any) {
      if (error?.code === '23505') {
        return res.status(409).json({ success: false, message: 'Ya existe una etiqueta con ese nombre' });
      }
      next(error);
    }
  });

  router.get('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      res.json({ success: true, data: normalizeTag(tag) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const current = await findTag(companyId, tagId);
      if (!current) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });
      if (current.is_default) {
        return res.status(400).json({ success: false, message: 'La etiqueta Todo no se puede editar' });
      }

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : current.name;
      const color = req.body?.color !== undefined ? String(req.body.color || '').trim() || null : current.color || null;
      if (!name || name.length > 80 || (color && color.length > 80)) {
        return res.status(400).json({ success: false, message: 'Usa un nombre de etiqueta y un color de hasta 80 caracteres' });
      }

      const result = await queryInTenantScope(pool, companyId,
        `UPDATE tags
         SET name = $1, color = $2, updated_at = NOW()
         WHERE company_id = $3 AND id = $4 AND NOT is_default
         RETURNING *`,
        [name, color, companyId, tagId]
      );

      if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });
      res.json({ success: true, data: normalizeTag({ ...current, ...result.rows[0] }) });
    } catch (error: any) {
      if (error?.code === '23505') {
        return res.status(409).json({ success: false, message: 'Ya existe una etiqueta con ese nombre' });
      }
      next(error);
    }
  });

  router.delete('/:id', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const current = await findTag(companyId, tagId);
      if (!current) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });
      if (current.is_default) {
        return res.status(400).json({ success: false, message: 'La etiqueta Todo no se puede eliminar' });
      }

      await queryInTenantScope(pool, companyId, 'DELETE FROM tags WHERE company_id = $1 AND id = $2 AND NOT is_default', [companyId, tagId]);
      res.json({ success: true, message: 'Etiqueta eliminada' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/chats/full', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      const data = await listChatsForCompany(companyId, tag.is_default ? undefined : tagId);
      res.json({
        success: true,
        data,
        tag: normalizeTag(tag),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/chats', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      if (tag.is_default) {
        const result = await queryInTenantScope(pool, companyId,
          `SELECT external_conversation_id
           FROM conversations
           WHERE company_id = $1 AND channel = 'whatsapp' AND archived_at IS NULL
           ORDER BY last_message_at DESC NULLS LAST`,
          [companyId]
        );
        return res.json({ success: true, data: result.rows.map((row) => row.external_conversation_id) });
      }

      const result = await queryInTenantScope(pool, companyId,
        `SELECT chat_id
         FROM tag_chats
         WHERE company_id = $1 AND tag_id = $2
         ORDER BY created_at DESC`,
        [companyId, tagId]
      );
      return res.json({ success: true, data: result.rows.map((row) => row.chat_id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/chats', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      const chatIds = chatLookupValues(req.body?.chatId || req.body?.chat_id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });
      if (!chatIds.length) return res.status(400).json({ success: false, message: 'Chat requerido' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });
      if (tag.is_default) return res.json({ success: true, message: 'Todo ya incluye todos los chats' });

      const assignment = await queryInTenantScope(pool, companyId,
        `INSERT INTO tag_chats (company_id, tag_id, conversation_id, chat_id, created_by)
         SELECT t.company_id, t.id, c.id, c.external_conversation_id, $4::bigint
         FROM tags t
         CROSS JOIN LATERAL (
           SELECT id, external_conversation_id
           FROM conversations
           WHERE company_id = t.company_id AND channel = 'whatsapp' AND archived_at IS NULL
             AND external_conversation_id = ANY($3::varchar[])
           ORDER BY (external_conversation_id = ($3::varchar[])[1]) DESC, last_message_at DESC NULLS LAST, id DESC
           LIMIT 1
         ) c
         WHERE t.company_id = $1 AND t.id = $2 AND NOT t.is_default
         ON CONFLICT (tag_id, chat_id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id
         RETURNING id`,
        [companyId, tagId, chatIds, req.user?.userId || null]
      );
      if (!assignment.rowCount) return res.status(404).json({ success: false, message: 'Chat o etiqueta no encontrados' });

      res.json({ success: true, message: 'Chat asignado a la etiqueta' });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/chats/:chatId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      const chatIds = chatLookupValues(req.params.chatId);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });
      if (!chatIds.length) return res.status(400).json({ success: false, message: 'Chat invalido' });

      await queryInTenantScope(pool, companyId,
        'DELETE FROM tag_chats WHERE company_id = $1 AND tag_id = $2 AND chat_id = ANY($3::varchar[])',
        [companyId, tagId, chatIds]
      );

      res.json({ success: true, message: 'Chat removido de la etiqueta' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/users', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      const result = await queryInTenantScope(pool, companyId,
        `SELECT u.id, u.nombre, u.email, u.rol, tu.created_at
         FROM tag_users tu
         JOIN usuarios u ON u.id = tu.user_id AND u.company_id = tu.company_id
         WHERE tu.company_id = $1 AND tu.tag_id = $2 AND u.activo = true
         ORDER BY u.nombre ASC`,
        [companyId, tagId]
      );

      res.json({
        success: true,
        data: result.rows.map((row) => ({
          id: String(row.id),
          employee_id: String(row.id),
          nombre: row.nombre,
          email: row.email,
          rol: row.rol,
          created_at: row.created_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/users', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      const employeeId = Number(req.body?.employeeId || req.body?.employee_id || req.body?.userId || req.body?.user_id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });
      if (!Number.isSafeInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ success: false, message: 'Empleado invalido' });
      }

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      const employeeResult = await queryInTenantScope(pool, companyId,
        `SELECT id
         FROM usuarios
         WHERE id = $1 AND company_id = $2 AND activo = true`,
        [employeeId, companyId]
      );
      if (!employeeResult.rows[0]) {
        return res.status(404).json({ success: false, message: 'Empleado no encontrado en esta empresa' });
      }

      await queryInTenantScope(pool, companyId,
        `INSERT INTO tag_users (company_id, tag_id, user_id, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tag_id, user_id) DO NOTHING`,
        [companyId, tagId, employeeId, req.user?.userId || null]
      );

      res.json({ success: true, message: 'Etiqueta asignada al empleado' });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id/users/:employeeId', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      if (!requireAdmin(req, res)) return;

      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      const employeeId = Number(req.params.employeeId);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });
      if (!Number.isSafeInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ success: false, message: 'Empleado invalido' });
      }

      await queryInTenantScope(pool, companyId,
        'DELETE FROM tag_users WHERE company_id = $1 AND tag_id = $2 AND user_id = $3',
        [companyId, tagId, employeeId]
      );

      res.json({ success: true, message: 'Etiqueta revocada del empleado' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/stats', async (req: JwtRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = resolveWhatsappCompanyId(req);
      const tagId = parseTagId(req.params.id);
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      const chatCountResult = tag.is_default
        ? await queryInTenantScope(pool, companyId,
            `SELECT COUNT(*)::int AS count
             FROM conversations
             WHERE company_id = $1 AND channel = 'whatsapp' AND archived_at IS NULL`,
            [companyId]
          )
        : await queryInTenantScope(pool, companyId,
            'SELECT COUNT(*)::int AS count FROM tag_chats WHERE company_id = $1 AND tag_id = $2',
            [companyId, tagId]
          );

      const employeeCountResult = await queryInTenantScope(pool, companyId,
        'SELECT COUNT(*)::int AS count FROM tag_users WHERE company_id = $1 AND tag_id = $2',
        [companyId, tagId]
      );

      res.json({
        success: true,
        data: {
          chat_count: Number(chatCountResult.rows[0]?.count || 0),
          employee_count: Number(employeeCountResult.rows[0]?.count || 0),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
