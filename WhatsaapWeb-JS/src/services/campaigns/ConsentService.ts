import crypto from 'node:crypto';
import {
  ChannelKind,
  ConsentPurpose,
  ConsentStatus,
  ConsentEvidenceType,
  ConsentRecordV1,
  RecordConsentInputV1,
  ConsentVerificationResultV1,
  RightToBeForgottenResultV1,
  recordConsentInputV1Schema,
  consentPurposeSchema,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { KnowledgeBaseService, knowledgeBaseService } from '../ai/rag/KnowledgeBaseService';
import { CampaignRequestError } from './CampaignRequestError';

export interface ConsentRecordFilter {
  channelType?: ChannelKind;
  destination?: string;
  purpose?: ConsentPurpose;
  status?: ConsentStatus;
  contactId?: number;
}

export class ConsentService {
  // Isolated store used only when tests explicitly pass a null Unit of Work.
  private memoryLedger = new Map<string, ConsentRecordV1>();

  constructor(
    private readonly uow: TenantScopedUoW | null = tenantScopedUoW,
    private readonly ragService: Pick<KnowledgeBaseService, 'purgeKnowledge'> = knowledgeBaseService
  ) {}

  private memoryKey(tenantId: number | string, channel: string, destination: string, purpose: string): string {
    return `${tenantId}:${channel}:${destination.toLowerCase().trim()}:${purpose}`;
  }

  /**
   * Records or updates a customer consent record (Opt-In / Opt-Out / Suppression).
   */
  async recordConsent(
    tenantId: number,
    rawInput: RecordConsentInputV1
  ): Promise<ConsentRecordV1> {
    const input = recordConsentInputV1Schema.parse(rawInput);
    const id = `cst_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const destination = input.destination.trim().toLowerCase();
    if (!destination) throw new CampaignRequestError(400, 'INVALID_DESTINATION', 'El destinatario es obligatorio.');
    const revokedAt = (input.status === 'opted_out' || input.status === 'revoked' || input.status === 'suppressed')
      ? now
      : null;

    if (!this.uow) {
      const record: ConsentRecordV1 = {
        id,
        tenantId,
        contactId: input.contactId || null,
        channelType: input.channelType,
        destination,
        purpose: input.purpose,
        status: input.status,
        evidenceType: input.evidenceType,
        evidenceProof: input.evidenceProof || {},
        optedInAt: now,
        revokedAt,
        createdAt: now,
        updatedAt: now,
      };
      this.memoryLedger.set(this.memoryKey(tenantId, record.channelType, record.destination, record.purpose), record);
      return record;
    }

    return await this.uow.run(tenantId, async (client) => {
      if (input.contactId) {
        const contact = await client.query('SELECT id FROM contacts WHERE company_id = $1 AND id = $2', [tenantId, input.contactId]);
        if (!contact.rows.length) throw new CampaignRequestError(404, 'CONTACT_NOT_FOUND', 'Contacto no encontrado.');
      }
      const sql = `
        INSERT INTO consent_records (
          id, tenant_id, contact_id, channel_type, destination, purpose,
          status, evidence_type, evidence_proof, opted_in_at, revoked_at,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, NOW(), NOW()
        )
        ON CONFLICT (tenant_id, channel_type, destination, purpose)
        DO UPDATE SET
          contact_id = COALESCE(EXCLUDED.contact_id, consent_records.contact_id),
          status = EXCLUDED.status,
          evidence_type = EXCLUDED.evidence_type,
          evidence_proof = EXCLUDED.evidence_proof,
          opted_in_at = CASE WHEN EXCLUDED.status = 'opted_in' THEN EXCLUDED.opted_in_at ELSE consent_records.opted_in_at END,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = NOW()
        RETURNING *;
      `;
      const res = await client.query(sql, [
        id,
        tenantId,
        input.contactId || null,
        input.channelType,
        destination,
        input.purpose,
        input.status,
        input.evidenceType,
        JSON.stringify(input.evidenceProof || {}),
        now,
        revokedAt,
      ]);
      const row = res.rows[0];
      const record: ConsentRecordV1 = {
        id: row.id,
        tenantId: Number(row.tenant_id),
        contactId: row.contact_id ? Number(row.contact_id) : null,
        channelType: row.channel_type as ChannelKind,
        destination: row.destination,
        purpose: row.purpose as ConsentPurpose,
        status: row.status as ConsentStatus,
        evidenceType: row.evidence_type as ConsentEvidenceType,
        evidenceProof: typeof row.evidence_proof === 'string' ? JSON.parse(row.evidence_proof) : row.evidence_proof,
        optedInAt: new Date(row.opted_in_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };

      return record;
    });
  }

  async recordOptIn(
    tenantId: number,
    input: Omit<RecordConsentInputV1, 'status'>
  ): Promise<ConsentRecordV1> {
    return this.recordConsent(tenantId, { ...input, status: 'opted_in' });
  }

  async recordOptOut(
    tenantId: number,
    input: Omit<RecordConsentInputV1, 'status'>
  ): Promise<ConsentRecordV1> {
    return this.recordConsent(tenantId, { ...input, status: 'opted_out' });
  }

  /**
   * Pre-dispatch consent verification.
   * Fail-closed: destination must have active opted_in status for the purpose,
   * and must not be in suppression / opted_out / revoked state.
   */
  async verifyConsent(
    tenantId: number,
    channel: ChannelKind,
    destination: string,
    purpose: ConsentPurpose = 'marketing'
  ): Promise<ConsentVerificationResultV1> {
    const normDest = destination.trim().toLowerCase();
    if (!normDest) throw new CampaignRequestError(400, 'INVALID_DESTINATION', 'El destinatario es obligatorio.');
    const alternateDest = channel === 'whatsapp-cloud' && /^\+?\d+$/.test(normDest)
      ? normDest.startsWith('+') ? normDest.slice(1) : '+' + normDest
      : normDest;
    consentPurposeSchema.parse(purpose);
    const records: Array<{ id: string; status: ConsentStatus }> = this.uow
      ? await this.uow.run(tenantId, async (client) => {
          const result = await client.query(
            `SELECT id, status FROM consent_records
             WHERE tenant_id = $1 AND channel_type = $2 AND LOWER(destination) IN ($3, $5)
               AND purpose IN ($4, 'all')
             ORDER BY CASE WHEN purpose = $4 THEN 0 ELSE 1 END, updated_at DESC`,
            [tenantId, channel, normDest, purpose, alternateDest]
          );
          return result.rows;
        })
      : ['all', purpose].flatMap((scope) => [normDest, alternateDest].map((address) =>
          this.memoryLedger.get(this.memoryKey(tenantId, channel, address, scope))))
          .filter((record): record is ConsentRecordV1 => Boolean(record));

    const suppression = records.find(({ status }) => status === 'suppressed' || status === 'opted_out');
    if (suppression) return { permitted: false, status: suppression.status, reason: 'SUPPRESSED', recordId: suppression.id };
    const revocation = records.find(({ status }) => status === 'revoked');
    if (revocation) return { permitted: false, status: 'revoked', reason: 'REVOKED', recordId: revocation.id };
    const consent = records.find(({ status }) => status === 'opted_in');
    if (consent) return { permitted: true, status: 'opted_in', reason: 'CONSENT_GRANTED', recordId: consent.id };
    if (purpose === 'marketing' || purpose === 'broadcast' || purpose === 'all') {
      return { permitted: false, status: 'not_found', reason: 'NO_OPT_IN_RECORD' };
    }
    return { permitted: true, status: 'not_found', reason: 'CONSENT_GRANTED' };
  }

  /**
   * GDPR Article 17 Right to be Forgotten:
   * 1. Revokes and suppresses all consent records for customer/destination
   * 2. Coordinates with KnowledgeBaseService to purge pgvector chunks
   * 3. Anonymizes contact personal data
   */
  async executeRightToBeForgotten(
    tenantId: number,
    customerId: string,
    destination?: string
  ): Promise<RightToBeForgottenResultV1> {
    let purgedConsentCount = 0;
    let anonymizedContact = false;
    const now = new Date().toISOString();

    const id = /^\d+$/.test(customerId) ? Number(customerId) : null;
    const contactId = id && id <= 2147483647 ? id : null;
    if (this.uow) {
      await this.uow.run(tenantId, async (client) => {
        // Revoke consent records by contact_id or destination
        const revokeSql = `
          UPDATE consent_records
          SET status = 'revoked',
              evidence_type = 'right_to_be_forgotten',
              evidence_proof = jsonb_build_object('customerId', $4::text, 'requestedAt', NOW()),
              revoked_at = NOW(),
              updated_at = NOW()
          WHERE tenant_id = $1
            AND (
              contact_id = $2::integer
              OR ($3::text IS NOT NULL AND LOWER(destination) = LOWER($3))
            )
          RETURNING id;
        `;
        const res = await client.query(revokeSql, [tenantId, contactId, destination?.trim() || null, customerId]);
        purgedConsentCount = res.rowCount || 0;

        // Anonymize contact using company_id for operational core tenant isolation
        const anonSql = `
          UPDATE contacts
          SET name = 'Anonymized Contact',
              display_name = 'Anonymized Contact',
              profile_name = 'Anonymized Contact',
              metadata_json = '{}'::jsonb,
              updated_at = NOW()
          WHERE company_id = $1
            AND (
              id = $2::integer
              OR ($3::text IS NOT NULL AND phone = $3)
            );
        `;
        const anonRes = await client.query(anonSql, [tenantId, contactId, destination?.trim() || null]);
        anonymizedContact = (anonRes.rowCount || 0) > 0;
      });
    } else {
      for (const [key, record] of this.memoryLedger.entries()) {
        const destMatch = destination && record.destination.toLowerCase() === destination.toLowerCase();
        const custMatch = record.contactId && String(record.contactId) === customerId;
        if (record.tenantId === tenantId && (destMatch || custMatch)) {
          record.status = 'revoked';
          record.evidenceType = 'right_to_be_forgotten';
          record.revokedAt = now;
          this.memoryLedger.set(key, record);
          purgedConsentCount++;
        }
      }
      anonymizedContact = purgedConsentCount > 0;
    }

    // Purge RAG knowledge after committing the consent revocation.
    const ragPurge = await this.ragService.purgeKnowledge(tenantId, {
      scope: 'customer',
      targetId: customerId,
      reason: 'GDPR Article 17 Right to be Forgotten',
    });
    if (!ragPurge.success) {
      throw new CampaignRequestError(503, 'KNOWLEDGE_PURGE_UNCONFIRMED', 'No se pudo confirmar el borrado de conocimiento.');
    }

    return {
      success: true,
      purgedConsentCount,
      purgedChunksCount: ragPurge.purgedChunksCount,
      anonymizedContact,
      executedAt: now,
    };
  }

  /**
   * Retrieves consent records matching criteria.
   */
  async listConsentRecords(
    tenantId: number,
    filter: ConsentRecordFilter = {}
  ): Promise<ConsentRecordV1[]> {
    if (!this.uow) {
      const results: ConsentRecordV1[] = [];
      for (const record of this.memoryLedger.values()) {
        if (record.tenantId !== tenantId) continue;
        if (filter.channelType && record.channelType !== filter.channelType) continue;
        if (filter.destination && record.destination.toLowerCase() !== filter.destination.toLowerCase()) continue;
        if (filter.purpose && record.purpose !== filter.purpose) continue;
        if (filter.status && record.status !== filter.status) continue;
        if (filter.contactId && record.contactId !== filter.contactId) continue;
        results.push(record);
      }
      return results;
    }

    return await this.uow.run(tenantId, async (client) => {
      let sql = `SELECT * FROM consent_records WHERE tenant_id = $1`;
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (filter.channelType) {
        sql += ` AND channel_type = $${idx++}`;
        params.push(filter.channelType);
      }
      if (filter.destination) {
        sql += ` AND LOWER(destination) = LOWER($${idx++})`;
        params.push(filter.destination);
      }
      if (filter.purpose) {
        sql += ` AND purpose = $${idx++}`;
        params.push(filter.purpose);
      }
      if (filter.status) {
        sql += ` AND status = $${idx++}`;
        params.push(filter.status);
      }
      if (filter.contactId) {
        sql += ` AND contact_id = $${idx++}`;
        params.push(filter.contactId);
      }

      sql += ` ORDER BY updated_at DESC LIMIT 100;`;
      const res = await client.query(sql, params);
      return res.rows.map((row) => ({
        id: row.id,
        tenantId: Number(row.tenant_id),
        contactId: row.contact_id ? Number(row.contact_id) : null,
        channelType: row.channel_type as ChannelKind,
        destination: row.destination,
        purpose: row.purpose as ConsentPurpose,
        status: row.status as ConsentStatus,
        evidenceType: row.evidence_type as ConsentEvidenceType,
        evidenceProof: typeof row.evidence_proof === 'string' ? JSON.parse(row.evidence_proof) : row.evidence_proof,
        optedInAt: new Date(row.opted_in_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    });
  }
}

export const consentService = new ConsentService();
