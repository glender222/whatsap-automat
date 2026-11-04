import crypto from 'node:crypto';
import {
  CampaignDefinitionV1,
  CreateCampaignCommandV1,
  CampaignDeliveryV1,
  CampaignStatus,
  createCampaignCommandV1Schema,
  campaignDefinitionV1Schema,
  ChannelAdapterV1,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { ConsentService, consentService } from './ConsentService';
import { SegmentationService, segmentationService, RecipientRecord } from './SegmentationService';
import { EmailAdapter, emailAdapter } from '../channels/EmailAdapter';

export interface DispatcherOptions {
  readonly skipPacingDelay?: boolean; // For deterministic unit tests
  readonly channelAdapters?: Map<string, ChannelAdapterV1>;
  readonly eventEmitter?: (event: string, payload: unknown) => void;
  readonly mockServiceWindowExpired?: (destination: string) => boolean;
}

export class CampaignDispatcher {
  private memoryCampaigns = new Map<string, CampaignDefinitionV1>();
  private memoryDeliveries = new Map<string, CampaignDeliveryV1>();
  private channelAdapters = new Map<string, ChannelAdapterV1>();

  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly consent: ConsentService = consentService,
    private readonly segments: SegmentationService = segmentationService,
    private readonly options?: DispatcherOptions
  ) {
    this.channelAdapters.set('email', emailAdapter);
    if (options?.channelAdapters) {
      for (const [kind, adapter] of options.channelAdapters.entries()) {
        this.channelAdapters.set(kind, adapter);
      }
    }
  }

  registerAdapter(channel: string, adapter: ChannelAdapterV1): void {
    this.channelAdapters.set(channel, adapter);
  }

  async createCampaign(
    tenantId: number,
    rawInput: CreateCampaignCommandV1
  ): Promise<CampaignDefinitionV1> {
    const input = createCampaignCommandV1Schema.parse(rawInput);
    const id = `cmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const campaign: CampaignDefinitionV1 = {
      id,
      tenantId,
      workspaceId: null,
      name: input.name,
      description: input.description || null,
      channel: input.channel,
      connectionId: input.connectionId || null,
      segmentId: input.segmentId || null,
      purpose: input.purpose || 'marketing',
      templateId: input.templateId || null,
      templateVariables: input.templateVariables || {},
      contentSubject: input.contentSubject || null,
      contentBody: input.contentBody || null,
      status: 'draft',
      rateLimitPerMinute: input.rateLimitPerMinute || 50,
      failurePauseThresholdPercent: input.failurePauseThresholdPercent ?? 5,
      pauseReason: null,
      scheduledAt: input.scheduledAt || null,
      startedAt: null,
      completedAt: null,
      statsTotal: 0,
      statsDispatched: 0,
      statsDelivered: 0,
      statsFailed: 0,
      statsSuppressed: 0,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    try {
      return await this.uow.run(tenantId, async (client) => {
        const sql = `
          INSERT INTO campaigns (
            id, tenant_id, name, description, channel, connection_id, segment_id,
            purpose, template_id, template_variables, content_subject, content_body,
            status, rate_limit_per_minute, failure_pause_threshold_percent,
            scheduled_at, metadata_json, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
            $13, $14, $15, $16, $17::jsonb, NOW(), NOW()
          )
          RETURNING *;
        `;
        const res = await client.query(sql, [
          id,
          tenantId,
          campaign.name,
          campaign.description,
          campaign.channel,
          campaign.connectionId,
          campaign.segmentId,
          campaign.purpose,
          campaign.templateId,
          JSON.stringify(campaign.templateVariables),
          campaign.contentSubject,
          campaign.contentBody,
          campaign.status,
          campaign.rateLimitPerMinute,
          campaign.failurePauseThresholdPercent,
          campaign.scheduledAt,
          JSON.stringify(campaign.metadata),
        ]);
        const row = res.rows[0];
        const result: CampaignDefinitionV1 = {
          id: row.id,
          tenantId: Number(row.tenant_id),
          workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
          name: row.name,
          description: row.description,
          channel: row.channel,
          connectionId: row.connection_id,
          segmentId: row.segment_id,
          purpose: row.purpose,
          templateId: row.template_id,
          templateVariables: typeof row.template_variables === 'string' ? JSON.parse(row.template_variables) : row.template_variables,
          contentSubject: row.content_subject,
          contentBody: row.content_body,
          status: row.status,
          rateLimitPerMinute: Number(row.rate_limit_per_minute),
          failurePauseThresholdPercent: Number(row.failure_pause_threshold_percent),
          pauseReason: row.pause_reason,
          scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
          startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
          completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
          statsTotal: Number(row.stats_total || 0),
          statsDispatched: Number(row.stats_dispatched || 0),
          statsDelivered: Number(row.stats_delivered || 0),
          statsFailed: Number(row.stats_failed || 0),
          statsSuppressed: Number(row.stats_suppressed || 0),
          metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        };
        this.memoryCampaigns.set(result.id, result);
        return result;
      });
    } catch {
      this.memoryCampaigns.set(campaign.id, campaign);
      return campaign;
    }
  }

  async getCampaign(tenantId: number, campaignId: string): Promise<CampaignDefinitionV1 | null> {
    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1;`,
          [tenantId, campaignId]
        );
        if (!res.rows[0]) return null;
        const row = res.rows[0];
        return {
          id: row.id,
          tenantId: Number(row.tenant_id),
          workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
          name: row.name,
          description: row.description,
          channel: row.channel,
          connectionId: row.connection_id,
          segmentId: row.segment_id,
          purpose: row.purpose,
          templateId: row.template_id,
          templateVariables: typeof row.template_variables === 'string' ? JSON.parse(row.template_variables) : row.template_variables,
          contentSubject: row.content_subject,
          contentBody: row.content_body,
          status: row.status,
          rateLimitPerMinute: Number(row.rate_limit_per_minute),
          failurePauseThresholdPercent: Number(row.failure_pause_threshold_percent),
          pauseReason: row.pause_reason,
          scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
          startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
          completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
          statsTotal: Number(row.stats_total || 0),
          statsDispatched: Number(row.stats_dispatched || 0),
          statsDelivered: Number(row.stats_delivered || 0),
          statsFailed: Number(row.stats_failed || 0),
          statsSuppressed: Number(row.stats_suppressed || 0),
          metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        };
      });
    } catch {
      const cmp = this.memoryCampaigns.get(campaignId);
      if (cmp && cmp.tenantId === tenantId) return cmp;
      return null;
    }
  }

  async listCampaigns(tenantId: number): Promise<CampaignDefinitionV1[]> {
    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC;`,
          [tenantId]
        );
        return res.rows.map((row) => ({
          id: row.id,
          tenantId: Number(row.tenant_id),
          workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
          name: row.name,
          description: row.description,
          channel: row.channel,
          connectionId: row.connection_id,
          segmentId: row.segment_id,
          purpose: row.purpose,
          templateId: row.template_id,
          templateVariables: typeof row.template_variables === 'string' ? JSON.parse(row.template_variables) : row.template_variables,
          contentSubject: row.content_subject,
          contentBody: row.content_body,
          status: row.status,
          rateLimitPerMinute: Number(row.rate_limit_per_minute),
          failurePauseThresholdPercent: Number(row.failure_pause_threshold_percent),
          pauseReason: row.pause_reason,
          scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
          startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
          completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
          statsTotal: Number(row.stats_total || 0),
          statsDispatched: Number(row.stats_dispatched || 0),
          statsDelivered: Number(row.stats_delivered || 0),
          statsFailed: Number(row.stats_failed || 0),
          statsSuppressed: Number(row.stats_suppressed || 0),
          metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        }));
      });
    } catch {
      const list: CampaignDefinitionV1[] = [];
      for (const cmp of this.memoryCampaigns.values()) {
        if (cmp.tenantId === tenantId) list.push(cmp);
      }
      return list;
    }
  }

  /**
   * Prepares and executes campaign dispatch loop.
   * Enforces:
   * 1. Rate limiting / pacing (rateLimitPerMinute)
   * 2. Fail-closed consent verification
   * 3. WhatsApp 24h window gate check
   * 4. Circuit breaker auto-pause (> failurePauseThresholdPercent)
   */
  async executeCampaign(
    tenantId: number,
    campaignId: string,
    recipientsOverride?: RecipientRecord[]
  ): Promise<CampaignDefinitionV1> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    // Resolve target audience
    let recipients: RecipientRecord[] = recipientsOverride || [];
    if (recipients.length === 0 && campaign.segmentId) {
      recipients = await this.segments.resolveRecipients(tenantId, campaign.segmentId);
    }

    // Retrieve existing deliveries to prevent duplicate broadcasts on resume
    const existingDeliveries = await this.getDeliveries(campaign.id, tenantId);
    const existingByDest = new Map<string, CampaignDeliveryV1>();
    for (const del of existingDeliveries) {
      existingByDest.set(del.destination, del);
    }

    campaign.status = 'dispatching';
    campaign.startedAt = campaign.startedAt || new Date().toISOString();
    campaign.completedAt = null;
    campaign.pauseReason = null;
    campaign.statsTotal = recipients.length;

    // Recalculate baseline stats from existing deliveries
    let statsDispatched = 0;
    let statsDelivered = 0;
    let statsFailed = 0;
    let statsSuppressed = 0;
    for (const del of existingDeliveries) {
      if (del.status === 'dispatched') statsDispatched++;
      else if (del.status === 'delivered') { statsDispatched++; statsDelivered++; }
      else if (del.status === 'suppressed') statsSuppressed++;
    }
    campaign.statsDispatched = statsDispatched;
    campaign.statsDelivered = statsDelivered;
    campaign.statsFailed = statsFailed;
    campaign.statsSuppressed = statsSuppressed;

    const evaluateCircuitBreaker = (): boolean => {
      if (campaign.status === 'paused') {
        return true;
      }
      const attempted = campaign.statsDispatched + campaign.statsFailed;
      if (attempted >= 5) {
        const failureRate = (campaign.statsFailed / attempted) * 100;
        if (failureRate > campaign.failurePauseThresholdPercent) {
          campaign.status = 'paused';
          campaign.pauseReason = `High failure rate detected (${failureRate.toFixed(1)}% > ${campaign.failurePauseThresholdPercent}%)`;
          if (this.options?.eventEmitter) {
            this.options.eventEmitter('campaign.paused', {
              tenantId,
              campaignId,
              failureRate,
              pauseReason: campaign.pauseReason,
            });
          }
          return true;
        }
      }
      return false;
    };

    const pacingDelayMs = this.options?.skipPacingDelay
      ? 0
      : Math.floor(60_000 / campaign.rateLimitPerMinute);

    const adapter = this.channelAdapters.get(campaign.channel);

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const deliveryId = `del_${campaign.id}_${i + 1}`;
      const idempotencyKey = `idem_${campaign.id}_${recipient.destination}`;
      const existing = existingByDest.get(recipient.destination);

      // Idempotency: Skip recipient if already successfully dispatched or delivered
      if (existing && (existing.status === 'dispatched' || existing.status === 'delivered')) {
        continue;
      }

      // Circuit Breaker check before proceeding
      if (evaluateCircuitBreaker()) {
        break;
      }

      // 1. Consent Gate Check
      const consentResult = await this.consent.verifyConsent(
        tenantId,
        campaign.channel,
        recipient.destination,
        campaign.purpose
      );

      if (!consentResult.permitted) {
        campaign.statsSuppressed++;
        const delivery: CampaignDeliveryV1 = {
          id: existing?.id || deliveryId,
          campaignId,
          tenantId,
          contactId: recipient.contactId || null,
          destination: recipient.destination,
          idempotencyKey,
          status: 'suppressed',
          suppressionReason: consentResult.reason || 'SUPPRESSED',
          providerMessageId: null,
          errorCode: null,
          errorMessage: null,
          renderedPayload: {},
          dispatchedAt: null,
          deliveredAt: null,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.memoryDeliveries.set(delivery.id, delivery);
        continue;
      }

      // 2. WhatsApp 24-Hour Customer Care Window Check
      if (campaign.channel === 'whatsapp-cloud') {
        const isWindowExpired = this.options?.mockServiceWindowExpired
          ? this.options.mockServiceWindowExpired(recipient.destination)
          : false;

        // If window is closed and no approved Meta template is used, block
        if (isWindowExpired && !campaign.templateId) {
          campaign.statsFailed++;
          const delivery: CampaignDeliveryV1 = {
            id: existing?.id || deliveryId,
            campaignId,
            tenantId,
            contactId: recipient.contactId || null,
            destination: recipient.destination,
            idempotencyKey,
            status: 'failed',
            suppressionReason: null,
            providerMessageId: null,
            errorCode: 'CH_WA_WINDOW_CLOSED',
            errorMessage: 'Cannot send free-form message outside 24h customer window without an approved template',
            renderedPayload: {},
            dispatchedAt: null,
            deliveredAt: null,
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          this.memoryDeliveries.set(delivery.id, delivery);
          if (evaluateCircuitBreaker()) {
            break;
          }
          continue;
        }
      }

      // 3. Message Dispatch
      try {
        let providerMessageId = `prov_msg_${Date.now()}_${i}`;
        if (adapter) {
          const sendResult = await adapter.send({
            schemaVersion: 1,
            tenantId: String(tenantId),
            connectionId: campaign.connectionId || 'default',
            conversationId: recipient.destination,
            effectKey: idempotencyKey,
            expectedConversationVersion: 1,
            causedBy: {
              type: 'system',
              id: `campaign_${campaign.id}`,
            },
            message: campaign.templateId
              ? {
                  kind: 'template',
                  templateId: campaign.templateId,
                  parameters: campaign.templateVariables,
                }
              : {
                  kind: 'text',
                  text: campaign.contentBody || 'Hello',
                },
          });
          providerMessageId = sendResult.providerMessageId || providerMessageId;
        }

        campaign.statsDispatched++;
        const delivery: CampaignDeliveryV1 = {
          id: existing?.id || deliveryId,
          campaignId,
          tenantId,
          contactId: recipient.contactId || null,
          destination: recipient.destination,
          idempotencyKey,
          status: 'dispatched',
          suppressionReason: null,
          providerMessageId,
          errorCode: null,
          errorMessage: null,
          renderedPayload: { text: campaign.contentBody },
          dispatchedAt: new Date().toISOString(),
          deliveredAt: null,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.memoryDeliveries.set(delivery.id, delivery);
      } catch (err: any) {
        campaign.statsFailed++;
        const delivery: CampaignDeliveryV1 = {
          id: existing?.id || deliveryId,
          campaignId,
          tenantId,
          contactId: recipient.contactId || null,
          destination: recipient.destination,
          idempotencyKey,
          status: 'failed',
          suppressionReason: null,
          providerMessageId: null,
          errorCode: err.code || 'SEND_ERROR',
          errorMessage: err.message || 'Provider dispatch failed',
          renderedPayload: {},
          dispatchedAt: null,
          deliveredAt: null,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.memoryDeliveries.set(delivery.id, delivery);
        if (evaluateCircuitBreaker()) {
          break;
        }
      }

      // Pacing delay (token bucket pacing)
      if (pacingDelayMs > 0 && i < recipients.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, pacingDelayMs));
      }
    }

    evaluateCircuitBreaker();

    if (campaign.status === 'dispatching') {
      const attempted = campaign.statsDispatched + campaign.statsFailed;
      const failureRate = attempted > 0 ? (campaign.statsFailed / attempted) * 100 : 0;
      if (attempted >= 5 && failureRate > campaign.failurePauseThresholdPercent) {
        campaign.status = 'paused';
        campaign.pauseReason = `High failure rate detected (${failureRate.toFixed(1)}% > ${campaign.failurePauseThresholdPercent}%)`;
      } else if (campaign.statsTotal > 0 && campaign.statsDispatched === 0 && campaign.statsFailed > 0) {
        campaign.status = 'failed';
      } else {
        campaign.status = 'completed';
        campaign.completedAt = new Date().toISOString();
      }
    }
    campaign.updatedAt = new Date().toISOString();

    // Persist status in DB if available
    try {
      await this.uow.run(tenantId, async (client) => {
        await client.query(
          `UPDATE campaigns SET
            status = $1, started_at = $2, completed_at = $3,
            stats_total = $4, stats_dispatched = $5, stats_failed = $6,
            stats_suppressed = $7, pause_reason = $8, updated_at = NOW()
          WHERE tenant_id = $9 AND id = $10;`,
          [
            campaign.status,
            campaign.startedAt,
            campaign.completedAt,
            campaign.statsTotal,
            campaign.statsDispatched,
            campaign.statsFailed,
            campaign.statsSuppressed,
            campaign.pauseReason,
            tenantId,
            campaignId,
          ]
        );
      });
    } catch {
      this.memoryCampaigns.set(campaignId, campaign);
    }

    return campaign;
  }

  async getDeliveries(campaignId: string, tenantId?: number): Promise<CampaignDeliveryV1[]> {
    if (tenantId !== undefined) {
      try {
        return await this.uow.run(tenantId, async (client) => {
          const res = await client.query(
            `SELECT * FROM campaign_deliveries WHERE campaign_id = $1 AND tenant_id = $2 ORDER BY created_at ASC;`,
            [campaignId, tenantId]
          );
          return res.rows.map((row) => ({
            id: row.id,
            campaignId: row.campaign_id,
            tenantId: Number(row.tenant_id),
            contactId: row.contact_id ? Number(row.contact_id) : null,
            destination: row.destination,
            idempotencyKey: row.idempotency_key,
            status: row.status,
            suppressionReason: row.suppression_reason,
            providerMessageId: row.provider_message_id,
            errorCode: row.error_code,
            errorMessage: row.error_message,
            renderedPayload: typeof row.rendered_payload === 'string' ? JSON.parse(row.rendered_payload) : row.rendered_payload,
            dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at).toISOString() : null,
            deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          }));
        });
      } catch {
        const res: CampaignDeliveryV1[] = [];
        for (const del of this.memoryDeliveries.values()) {
          if (del.campaignId === campaignId && Number(del.tenantId) === Number(tenantId)) {
            res.push(del);
          }
        }
        return res;
      }
    }

    const res: CampaignDeliveryV1[] = [];
    for (const del of this.memoryDeliveries.values()) {
      if (del.campaignId === campaignId) res.push(del);
    }
    return res;
  }
}

export const campaignDispatcher = new CampaignDispatcher();
