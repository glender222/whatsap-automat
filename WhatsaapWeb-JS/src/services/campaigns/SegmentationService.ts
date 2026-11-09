import crypto from 'node:crypto';
import {
  SegmentDefinitionV1,
  CreateSegmentCommandV1,
  SegmentCriteriaV1,
  SegmentRuleV1,
  SegmentTargetChannel,
  createSegmentCommandV1Schema,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { CampaignRequestError } from './CampaignRequestError';

export interface RecipientRecord {
  contactId: number;
  destination: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

function isSupportedRule({ field, operator, value }: SegmentRuleV1): boolean {
  if (field === 'tag') {
    const values = Array.isArray(value) ? value : [value];
    return ['equals', 'not_equals', 'includes_any', 'excludes'].includes(operator) &&
      values.length > 0 && values.every((item) => typeof item === 'string' && item.trim().length > 0);
  }
  if (field === 'last_seen_days') {
    return ['equals', 'lt', 'gt'].includes(operator) &&
      (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
      Number.isFinite(Number(value)) && Number(value) >= 0;
  }
  if (!/^metadata\.[a-z][a-z0-9_]*$/i.test(field)) return false;
  if (operator === 'exists') return true;
  if (operator === 'gt' || operator === 'lt') {
    return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
      Number.isFinite(Number(value));
  }
  return (operator === 'equals' || operator === 'not_equals') &&
    ['string', 'number', 'boolean'].includes(typeof value);
}

function destinationFor(
  target: SegmentTargetChannel,
  contact: { phone: string; email?: string; channel?: string; externalId?: string },
): string | null {
  if (target === 'email') {
    const email = contact.email?.trim();
    return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
  }
  if (target === 'any') return contact.phone || contact.email || contact.externalId || null;
  if (target === 'whatsapp-cloud') {
    return (!contact.channel || contact.channel === 'whatsapp' || contact.channel === 'whatsapp-cloud')
      ? contact.phone || null
      : null;
  }
  return contact.channel === target ? contact.externalId || null : null;
}

export class SegmentationService {
  private memorySegments = new Map<string, SegmentDefinitionV1>();
  private memoryContacts = new Map<number, {
    id: number;
    tenantId: number;
    phone: string;
    email?: string;
    displayName?: string;
    tags: string[];
    metadata: Record<string, unknown>;
    lastSeenAt: string;
  }>();

  constructor(private readonly uow: TenantScopedUoW | null = tenantScopedUoW) {}

  /**
   * Test helper to register contacts in memory for deterministic local tests.
   */
  seedMemoryContact(contact: {
    id: number;
    tenantId: number;
    phone: string;
    email?: string;
    displayName?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    lastSeenAt?: string;
  }): void {
    if (this.uow) throw new Error('Memory fixtures require an explicit in-memory service.');
    this.memoryContacts.set(contact.id, {
      id: contact.id,
      tenantId: contact.tenantId,
      phone: contact.phone,
      email: contact.email,
      displayName: contact.displayName || 'Test Contact',
      tags: contact.tags || [],
      metadata: contact.metadata || {},
      lastSeenAt: contact.lastSeenAt || new Date().toISOString(),
    });
  }

  async createSegment(
    tenantId: number,
    rawInput: CreateSegmentCommandV1
  ): Promise<SegmentDefinitionV1> {
    const input = createSegmentCommandV1Schema.parse(rawInput);
    const name = input.name.trim();
    if (!name || name.length > 255) {
      throw new CampaignRequestError(400, 'INVALID_SEGMENT_NAME', 'El nombre de segmento debe tener entre 1 y 255 caracteres.');
    }
    if (input.criteria.rules.some((rule) => !isSupportedRule(rule))) {
      throw new CampaignRequestError(400, 'INVALID_SEGMENT_RULE', 'La regla del segmento no es válida para ese campo.');
    }
    const id = `seg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const segment: SegmentDefinitionV1 = {
      id,
      tenantId,
      workspaceId: null,
      name,
      description: input.description || null,
      targetChannel: input.targetChannel,
      criteria: input.criteria,
      dynamic: input.dynamic ?? true,
      staticContactIds: input.staticContactIds || [],
      calculatedCount: 0,
      lastCalculatedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    if (!this.uow) {
      this.memorySegments.set(segment.id, segment);
      return segment;
    }

    return await this.uow.run(tenantId, async (client) => {
      const sql = `
        INSERT INTO segments (
          id, tenant_id, name, description, target_channel,
          criteria_json, dynamic, static_contact_ids, calculated_count,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6::jsonb, $7, $8, 0, NOW(), NOW()
        )
        RETURNING *;
      `;
      const res = await client.query(sql, [
        id,
        tenantId,
        segment.name,
        segment.description,
        segment.targetChannel,
        JSON.stringify(segment.criteria),
        segment.dynamic,
        segment.staticContactIds,
      ]);
      const row = res.rows[0];
      const result: SegmentDefinitionV1 = {
        id: row.id,
        tenantId: Number(row.tenant_id),
        workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
        name: row.name,
        description: row.description,
        targetChannel: row.target_channel,
        criteria: typeof row.criteria_json === 'string' ? JSON.parse(row.criteria_json) : row.criteria_json,
        dynamic: row.dynamic,
        staticContactIds: row.static_contact_ids || [],
        calculatedCount: Number(row.calculated_count || 0),
        lastCalculatedAt: row.last_calculated_at ? new Date(row.last_calculated_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      return result;
    });
  }

  async getSegment(tenantId: number, segmentId: string): Promise<SegmentDefinitionV1 | null> {
    if (!this.uow) {
      const seg = this.memorySegments.get(segmentId);
      if (seg && seg.tenantId === tenantId) return seg;
      return null;
    }

    return await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM segments WHERE tenant_id = $1 AND id = $2 LIMIT 1;`,
        [tenantId, segmentId]
      );
      if (!res.rows[0]) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        tenantId: Number(row.tenant_id),
        workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
        name: row.name,
        description: row.description,
        targetChannel: row.target_channel,
        criteria: typeof row.criteria_json === 'string' ? JSON.parse(row.criteria_json) : row.criteria_json,
        dynamic: row.dynamic,
        staticContactIds: row.static_contact_ids || [],
        calculatedCount: Number(row.calculated_count || 0),
        lastCalculatedAt: row.last_calculated_at ? new Date(row.last_calculated_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  async listSegments(tenantId: number): Promise<SegmentDefinitionV1[]> {
    if (!this.uow) {
      const list: SegmentDefinitionV1[] = [];
      for (const seg of this.memorySegments.values()) {
        if (seg.tenantId === tenantId) list.push(seg);
      }
      return list;
    }

    return await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM segments WHERE tenant_id = $1 ORDER BY created_at DESC;`,
        [tenantId]
      );
      return res.rows.map((row) => ({
        id: row.id,
        tenantId: Number(row.tenant_id),
        workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
        name: row.name,
        description: row.description,
        targetChannel: row.target_channel,
        criteria: typeof row.criteria_json === 'string' ? JSON.parse(row.criteria_json) : row.criteria_json,
        dynamic: row.dynamic,
        staticContactIds: row.static_contact_ids || [],
        calculatedCount: Number(row.calculated_count || 0),
        lastCalculatedAt: row.last_calculated_at ? new Date(row.last_calculated_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    });
  }

  private matchesRule(
    contact: { tags: string[]; metadata: Record<string, unknown>; lastSeenAt: string; phone: string; email?: string },
    rule: SegmentRuleV1
  ): boolean {
    if (!isSupportedRule(rule)) return false;
    const field = rule.field.toLowerCase();
    const val = rule.value;

    if (field === 'tag') {
      const targetTags = Array.isArray(val) ? val.map((v) => String(v).toLowerCase()) : [String(val).toLowerCase()];
      const contactTags = contact.tags.map((t) => t.toLowerCase());
      if (rule.operator === 'includes_any' || rule.operator === 'equals') {
        return contactTags.some((t) => targetTags.includes(t));
      }
      if (rule.operator === 'excludes' || rule.operator === 'not_equals') {
        return !contactTags.some((t) => targetTags.includes(t));
      }
    }

    if (field === 'last_seen_days') {
      const days = Number(val);
      const contactDate = new Date(contact.lastSeenAt).getTime();
      const diffDays = (Date.now() - contactDate) / (1000 * 60 * 60 * 24);
      if (rule.operator === 'lt') return diffDays < days;
      if (rule.operator === 'gt') return diffDays > days;
      if (rule.operator === 'equals') return Math.floor(diffDays) === days;
    }

    if (field.startsWith('metadata.')) {
      const key = rule.field.slice('metadata.'.length);
      const contactVal = contact.metadata[key];
      if (rule.operator === 'equals') return String(contactVal) === String(val);
      if (rule.operator === 'not_equals') return String(contactVal) !== String(val);
      if (rule.operator === 'exists') return contactVal !== undefined && contactVal !== null;
      if (contactVal == null || String(contactVal).trim() === '') return false;
      if (rule.operator === 'gt') return Number(contactVal) > Number(val);
      if (rule.operator === 'lt') return Number(contactVal) < Number(val);
    }

    return false;
  }

  private matchesCriteria(
    contact: { tags: string[]; metadata: Record<string, unknown>; lastSeenAt: string; phone: string; email?: string },
    criteria: SegmentCriteriaV1
  ): boolean {
    if (!criteria.rules || criteria.rules.length === 0) return true;
    if (criteria.rules.some((rule) => !isSupportedRule(rule))) return false;
    const combinator = criteria.combinator || 'AND';

    if (combinator === 'AND') {
      return criteria.rules.every((rule) => this.matchesRule(contact, rule));
    } else {
      return criteria.rules.some((rule) => this.matchesRule(contact, rule));
    }
  }

  async resolveRecipients(
    tenantId: number,
    segmentId: string,
    limit: number = 1000,
    offset: number = 0,
    deliveryChannel?: SegmentTargetChannel,
  ): Promise<RecipientRecord[]> {
    const segment = await this.getSegment(tenantId, segmentId);
    if (!segment) throw new CampaignRequestError(404, 'SEGMENT_NOT_FOUND', 'Segmento no encontrado.');
    const targetChannel = deliveryChannel ?? segment.targetChannel;
    if (deliveryChannel && segment.targetChannel !== 'any' && segment.targetChannel !== deliveryChannel) {
      throw new CampaignRequestError(409, 'SEGMENT_CHANNEL_MISMATCH', 'El segmento pertenece a otro canal.');
    }

    if (!this.uow) {
      const recipients: RecipientRecord[] = [];
      for (const contact of this.memoryContacts.values()) {
        if (contact.tenantId !== tenantId) continue;
        if (!segment.dynamic && !segment.staticContactIds.includes(contact.id)) continue;
        if (segment.dynamic && !this.matchesCriteria(contact, segment.criteria)) continue;

        const destination = destinationFor(targetChannel, contact);
        if (!destination) continue;
        recipients.push({
          contactId: contact.id,
          destination,
          name: contact.displayName,
          metadata: contact.metadata,
        });
      }

      return recipients.slice(offset, offset + limit);
    }

    return await this.uow.run(tenantId, async (client) => {
      // Query PostgreSQL contacts using company_id for operational core tenant isolation
      let sql = `
        SELECT c.id, c.phone, c.channel, c.external_contact_id, COALESCE(c.display_name, c.name, 'Contact') AS display_name,
               c.metadata_json,
               COALESCE(c.last_seen_at, c.created_at) AS last_seen_at,
               COALESCE(
                 (
                   SELECT array_agg(DISTINCT t.name)
                   FROM tag_chats tc
                   JOIN tags t ON t.id = tc.tag_id AND t.company_id = c.company_id
                   JOIN conversations conv ON conv.company_id = c.company_id
                     AND (conv.id = tc.conversation_id OR (
                       tc.conversation_id IS NULL AND conv.external_conversation_id = tc.chat_id
                     ))
                   WHERE conv.contact_id = c.id AND tc.company_id = c.company_id
                 ),
                 ARRAY[]::varchar[]
               ) AS db_tags
        FROM contacts c
        WHERE c.company_id = $1
      `;
      const params: unknown[] = [tenantId];

      if (!segment.dynamic) {
        sql += ` AND c.id = ANY($${params.length + 1}::integer[])`;
        params.push(segment.staticContactIds);
      }

      sql += ` ORDER BY c.id ASC;`;

      const res = await client.query(sql, params);

      // Enforce audience rule filtering across all database contacts
      const matchingRecipients: RecipientRecord[] = [];
      for (const row of res.rows) {
        const meta = typeof row.metadata_json === 'string'
          ? JSON.parse(row.metadata_json || '{}')
          : (row.metadata_json || {});
        const metaTags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
        const dbTags = Array.isArray(row.db_tags) ? row.db_tags.map(String) : [];
        const tags = Array.from(new Set([...dbTags, ...metaTags]));

        const contactObj = {
          id: Number(row.id),
          tenantId,
          phone: String(row.phone || ''),
          channel: String(row.channel || ''),
          externalId: String(row.external_contact_id || ''),
          email: typeof meta.email === 'string' ? meta.email : undefined,
          displayName: row.display_name,
          tags,
          metadata: meta,
          lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : new Date().toISOString(),
        };

        if (segment.dynamic && !this.matchesCriteria(contactObj, segment.criteria)) {
          continue;
        }

        const destination = destinationFor(targetChannel, contactObj);
        if (!destination) continue;
        matchingRecipients.push({
          contactId: contactObj.id,
          destination,
          name: contactObj.displayName,
          metadata: contactObj.metadata,
        });
      }

      return matchingRecipients.slice(offset, offset + limit);
    });
  }

  async evaluateSegmentCount(tenantId: number, segmentId: string): Promise<number> {
    const count = (await this.resolveRecipients(tenantId, segmentId, Number.MAX_SAFE_INTEGER)).length;
    if (!this.uow) {
      const segment = this.memorySegments.get(segmentId);
      if (segment) {
        segment.calculatedCount = count;
        segment.lastCalculatedAt = new Date().toISOString();
      }
    } else {
      await this.uow.run(tenantId, async (client) => {
        await client.query(
          'UPDATE segments SET calculated_count = $1, last_calculated_at = NOW(), updated_at = NOW() WHERE tenant_id = $2 AND id = $3',
          [count, tenantId, segmentId]
        );
      });
    }
    return count;
  }
}

export const segmentationService = new SegmentationService();
