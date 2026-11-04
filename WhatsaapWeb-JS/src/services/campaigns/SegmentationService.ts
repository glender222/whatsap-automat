import crypto from 'node:crypto';
import {
  SegmentDefinitionV1,
  CreateSegmentCommandV1,
  SegmentCriteriaV1,
  SegmentRuleV1,
  createSegmentCommandV1Schema,
  segmentDefinitionV1Schema,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';

export interface RecipientRecord {
  contactId: number;
  destination: string;
  name?: string;
  metadata?: Record<string, unknown>;
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

  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

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
    const id = `seg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const segment: SegmentDefinitionV1 = {
      id,
      tenantId,
      workspaceId: null,
      name: input.name,
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

    try {
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
        this.memorySegments.set(result.id, result);
        return result;
      });
    } catch {
      this.memorySegments.set(segment.id, segment);
      return segment;
    }
  }

  async getSegment(tenantId: number, segmentId: string): Promise<SegmentDefinitionV1 | null> {
    try {
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
    } catch {
      const seg = this.memorySegments.get(segmentId);
      if (seg && seg.tenantId === tenantId) return seg;
      return null;
    }
  }

  async listSegments(tenantId: number): Promise<SegmentDefinitionV1[]> {
    try {
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
    } catch {
      const list: SegmentDefinitionV1[] = [];
      for (const seg of this.memorySegments.values()) {
        if (seg.tenantId === tenantId) list.push(seg);
      }
      return list;
    }
  }

  private matchesRule(
    contact: { tags: string[]; metadata: Record<string, unknown>; lastSeenAt: string; phone: string; email?: string },
    rule: SegmentRuleV1
  ): boolean {
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
      if (rule.operator === 'gt') return Number(contactVal) > Number(val);
      if (rule.operator === 'lt') return Number(contactVal) < Number(val);
    }

    return true;
  }

  private matchesCriteria(
    contact: { tags: string[]; metadata: Record<string, unknown>; lastSeenAt: string; phone: string; email?: string },
    criteria: SegmentCriteriaV1
  ): boolean {
    if (!criteria.rules || criteria.rules.length === 0) return true;
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
    offset: number = 0
  ): Promise<RecipientRecord[]> {
    const segment = await this.getSegment(tenantId, segmentId);
    if (!segment) return [];

    try {
      return await this.uow.run(tenantId, async (client) => {
        // Query PostgreSQL contacts using company_id for operational core tenant isolation
        let sql = `
          SELECT c.id, c.phone, COALESCE(c.display_name, c.name, 'Contact') AS display_name,
                 c.metadata_json,
                 COALESCE(c.last_seen_at, c.created_at) AS last_seen_at,
                 COALESCE(
                   (
                     SELECT array_agg(DISTINCT t.name)
                     FROM tag_chats tc
                     JOIN tags t ON t.id = tc.tag_id AND t.company_id = c.company_id
                     JOIN conversations conv ON conv.id = tc.conversation_id AND conv.company_id = c.company_id
                     WHERE conv.contact_id = c.id
                   ),
                   ARRAY[]::varchar[]
                 ) AS db_tags
          FROM contacts c
          WHERE c.company_id = $1
        `;
        const params: unknown[] = [tenantId];

        if (!segment.dynamic && segment.staticContactIds.length > 0) {
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
            email: typeof meta.email === 'string' ? meta.email : undefined,
            displayName: row.display_name,
            tags,
            metadata: meta,
            lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : new Date().toISOString(),
          };

          if (segment.dynamic && !this.matchesCriteria(contactObj, segment.criteria)) {
            continue;
          }

          matchingRecipients.push({
            contactId: contactObj.id,
            destination: segment.targetChannel === 'email'
              ? (contactObj.email || `${contactObj.phone}@example.com`)
              : contactObj.phone,
            name: contactObj.displayName,
            metadata: contactObj.metadata,
          });
        }

        return matchingRecipients.slice(offset, offset + limit);
      });
    } catch {
      // Memory store fallback
      const recipients: RecipientRecord[] = [];
      for (const contact of this.memoryContacts.values()) {
        if (contact.tenantId !== tenantId) continue;
        if (!segment.dynamic && !segment.staticContactIds.includes(contact.id)) continue;
        if (segment.dynamic && !this.matchesCriteria(contact, segment.criteria)) continue;

        recipients.push({
          contactId: contact.id,
          destination: segment.targetChannel === 'email'
            ? (contact.email || `${contact.phone}@example.com`)
            : contact.phone,
          name: contact.displayName,
          metadata: contact.metadata,
        });
      }

      return recipients.slice(offset, offset + limit);
    }
  }

  async evaluateSegmentCount(tenantId: number, segmentId: string): Promise<number> {
    const recipients = await this.resolveRecipients(tenantId, segmentId);
    const count = recipients.length;

    try {
      await this.uow.run(tenantId, async (client) => {
        await client.query(
          `UPDATE segments SET calculated_count = $1, last_calculated_at = NOW(), updated_at = NOW() WHERE tenant_id = $2 AND id = $3;`,
          [count, tenantId, segmentId]
        );
      });
    } catch {
      const seg = this.memorySegments.get(segmentId);
      if (seg) {
        seg.calculatedCount = count;
        seg.lastCalculatedAt = new Date().toISOString();
        this.memorySegments.set(segmentId, seg);
      }
    }

    return count;
  }
}

export const segmentationService = new SegmentationService();
