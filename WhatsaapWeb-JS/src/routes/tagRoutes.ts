import { NextFunction, Response, Router } from 'express';
import pool from '../config/database';
import { JwtRequest, resolveWhatsappCompanyId } from '../middleware/jwtAuth';

type TagRow = Record<string, any>;

function normalizePhone(value: string): string {
  return String(value || '')
    .replace('@c.us', '')
    .replace('@s.whatsapp.net', '')
    .replace(/[^\d]/g, '');
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
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

async function ensureDefaultTag(companyId: number): Promise<void> {
  await pool.query(
    `INSERT INTO tags (company_id, name, color, is_default)
     VALUES ($1, 'Todo', 'text-green-500', TRUE)
     ON CONFLICT DO NOTHING`,
    [companyId]
  );
}

async function findTag(companyId: number, tagId: number): Promise<TagRow | null> {
  const result = await pool.query(
    `SELECT t.*,
            COUNT(DISTINCT tc.chat_id) FILTER (WHERE NOT t.is_default) AS chat_count,
            COUNT(DISTINCT tu.user_id) AS employee_count
     FROM tags t
     LEFT JOIN tag_chats tc ON tc.tag_id = t.id
     LEFT JOIN tag_users tu ON tu.tag_id = t.id
     WHERE t.company_id = $1 AND t.id = $2
     GROUP BY t.id`,
    [companyId, tagId]
  );
  return result.rows[0] || null;
}

async function listChatsForCompany(companyId: number, tagId?: number): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [companyId];
  let tagJoin = '';
  let tagFilter = '';

  if (tagId) {
    params.push(tagId);
    tagJoin = `JOIN tag_chats tc
                 ON tc.company_id = c.company_id
                AND tc.chat_id = c.external_conversation_id
                AND tc.tag_id = $2`;
    tagFilter = '';
  }

  const result = await pool.query(
    `SELECT
       c.external_conversation_id AS id,
       COALESCE(c.title, ct.display_name, ct.name, ct.profile_name, ct.phone, c.external_conversation_id) AS name,
       c.last_message_at,
       c.unread_count,
       c.last_message_preview,
       c.status,
       c.service_window_expires_at
     FROM conversations c
     ${tagJoin}
     LEFT JOIN contacts ct ON ct.id = c.contact_id
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

      const result = await pool.query(
        `SELECT t.*,
                COUNT(DISTINCT tc.chat_id) FILTER (WHERE NOT t.is_default) AS chat_count,
                COUNT(DISTINCT tu.user_id) AS employee_count
         FROM tags t
         LEFT JOIN tag_chats tc ON tc.tag_id = t.id
         LEFT JOIN tag_users tu ON tu.tag_id = t.id
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

      if (!name) {
        return res.status(400).json({ success: false, message: 'El nombre de la etiqueta es requerido' });
      }

      const result = await pool.query(
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
      if (!name) return res.status(400).json({ success: false, message: 'El nombre de la etiqueta es requerido' });

      const result = await pool.query(
        `UPDATE tags
         SET name = $1, color = $2, updated_at = NOW()
         WHERE company_id = $3 AND id = $4
         RETURNING *`,
        [name, color, companyId, tagId]
      );

      res.json({ success: true, data: normalizeTag(result.rows[0]) });
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

      await pool.query('DELETE FROM tags WHERE company_id = $1 AND id = $2', [companyId, tagId]);
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
        const result = await pool.query(
          `SELECT external_conversation_id
           FROM conversations
           WHERE company_id = $1 AND channel = 'whatsapp' AND archived_at IS NULL
           ORDER BY last_message_at DESC NULLS LAST`,
          [companyId]
        );
        return res.json({ success: true, data: result.rows.map((row) => row.external_conversation_id) });
      }

      const result = await pool.query(
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
      const chatId = normalizePhone(req.body?.chatId || req.body?.chat_id || '');
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });
      if (!chatId) return res.status(400).json({ success: false, message: 'Chat requerido' });

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });
      if (tag.is_default) return res.json({ success: true, message: 'Todo ya incluye todos los chats' });

      const conversationResult = await pool.query(
        `SELECT id
         FROM conversations
         WHERE company_id = $1 AND channel = 'whatsapp' AND external_conversation_id = $2
         LIMIT 1`,
        [companyId, chatId]
      );

      await pool.query(
        `INSERT INTO tag_chats (company_id, tag_id, conversation_id, chat_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tag_id, chat_id)
         DO UPDATE SET conversation_id = COALESCE(EXCLUDED.conversation_id, tag_chats.conversation_id)`,
        [companyId, tagId, conversationResult.rows[0]?.id || null, chatId, req.user?.userId || null]
      );

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
      const chatId = normalizePhone(String(req.params.chatId || ''));
      if (!tagId) return res.status(400).json({ success: false, message: 'Etiqueta invalida' });
      if (!chatId) return res.status(400).json({ success: false, message: 'Chat invalido' });

      await pool.query(
        'DELETE FROM tag_chats WHERE company_id = $1 AND tag_id = $2 AND chat_id = $3',
        [companyId, tagId, chatId]
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

      const result = await pool.query(
        `SELECT u.id, u.nombre, u.email, u.rol, tu.created_at
         FROM tag_users tu
         JOIN usuarios u ON u.id = tu.user_id
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
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ success: false, message: 'Empleado invalido' });
      }

      const tag = await findTag(companyId, tagId);
      if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

      const employeeResult = await pool.query(
        `SELECT id
         FROM usuarios
         WHERE id = $1 AND company_id = $2 AND activo = true`,
        [employeeId, companyId]
      );
      if (!employeeResult.rows[0]) {
        return res.status(404).json({ success: false, message: 'Empleado no encontrado en esta empresa' });
      }

      await pool.query(
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
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ success: false, message: 'Empleado invalido' });
      }

      await pool.query(
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
        ? await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM conversations
             WHERE company_id = $1 AND channel = 'whatsapp' AND archived_at IS NULL`,
            [companyId]
          )
        : await pool.query(
            'SELECT COUNT(*)::int AS count FROM tag_chats WHERE company_id = $1 AND tag_id = $2',
            [companyId, tagId]
          );

      const employeeCountResult = await pool.query(
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
