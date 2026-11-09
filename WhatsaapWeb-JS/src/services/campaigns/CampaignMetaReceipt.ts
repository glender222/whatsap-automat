import type { Queryable } from '../../shared/UnitOfWorkPort';

export const campaignCallbackPrefix = 'automat-campaign:';
export const unconfirmedDeliveryMessage = 'Hay entregas sin confirmar que requieren conciliación.';
export const reconciledDeliveryMessage = 'La entrega se concilió. Reanuda la campaña para continuar.';
const callbackPattern = /^automat-campaign:(del_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
export const metaMessageIdPattern = /^wamid\.[A-Za-z0-9+/_=-]{1,249}$/;

export async function lockCampaign(db: Queryable, tenantId: number, campaignId: string): Promise<void> {
  await db.query('SELECT id FROM campaigns WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, campaignId]);
}

// Call with the campaign locked. The dispatcher's counters and signed receipts share this source.
export async function refreshCampaignStats(db: Queryable, tenantId: number, campaignId: string) {
  const { rows: [totals] } = await db.query(`
    UPDATE campaigns c SET stats_dispatched = totals.dispatched, stats_delivered = totals.delivered,
      stats_failed = totals.failed, stats_suppressed = totals.suppressed, updated_at = clock_timestamp(),
      pause_reason = CASE WHEN c.status = 'paused' AND c.pause_reason = $3 AND NOT totals.has_pending
        THEN $4 ELSE c.pause_reason END
    FROM (
      SELECT COUNT(*) FILTER (WHERE status IN ('dispatched', 'delivered') OR dispatched_at IS NOT NULL) AS dispatched,
        COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'suppressed') AS suppressed,
        COALESCE(BOOL_OR(status = 'pending'), false) AS has_pending
      FROM campaign_deliveries WHERE tenant_id = $1 AND campaign_id = $2
    ) totals WHERE c.tenant_id = $1 AND c.id = $2
    RETURNING c.stats_dispatched, c.stats_delivered, c.stats_failed, c.stats_suppressed, totals.has_pending
  `, [tenantId, campaignId, unconfirmedDeliveryMessage, reconciledDeliveryMessage]);
  return totals;
}

export async function applyCampaignMetaReceipt(db: Queryable, tenantId: number, providerId: string, eventId: string): Promise<void> {
  if (!metaMessageIdPattern.test(providerId)) return;
  const { rows: [event] } = await db.query(`
    SELECT phone_number_id, received_at, payload_json->'status' AS status
    FROM whatsapp_webhook_events
    WHERE company_id = $1 AND provider = 'meta-cloud' AND provider_message_id = $2 AND id = $3
      AND payload_json #>> '{metadata,phone_number_id}' = phone_number_id
  `, [tenantId, providerId, eventId]);
  const status = event?.status;
  if (status?.id !== providerId || typeof status.recipient_id !== 'string' || !/^[1-9]\d{6,14}$/.test(status.recipient_id) ||
      typeof status.timestamp !== 'string' || !/^\d{1,11}$/.test(status.timestamp) ||
      typeof status.biz_opaque_callback_data !== 'string') return;
  const ref = callbackPattern.exec(status.biz_opaque_callback_data);
  const next = status.status === 'sent' ? 'dispatched' : status.status === 'failed' ? 'failed' :
    status.status === 'delivered' || status.status === 'read' ? 'delivered' : null;
  if (!ref || !next) return;

  const { rows: [delivery] } = await db.query(`
    SELECT d.campaign_id FROM campaign_deliveries d
    JOIN campaigns c ON c.id = d.campaign_id AND c.tenant_id = d.tenant_id
    JOIN channel_connections cc ON cc.id = d.meta_connection_id AND cc.tenant_id = d.tenant_id
      AND cc.channel = 'whatsapp-cloud' AND cc.account_id = d.meta_phone_number_id
    WHERE d.tenant_id = $1 AND d.id = $2 AND c.channel = 'whatsapp-cloud' AND c.connection_id = d.meta_connection_id
      AND d.meta_phone_number_id = $3 AND d.destination = $4
  `, [tenantId, ref[1], event.phone_number_id, status.recipient_id]);
  if (!delivery) return;
  await lockCampaign(db, tenantId, delivery.campaign_id);

  const occurredAt = new Date(Number(status.timestamp) * 1000);
  const changed = await db.query(`
    UPDATE campaign_deliveries d SET status = $4::varchar, provider_message_id = $3,
      dispatched_at = CASE WHEN $4 IN ('dispatched', 'delivered') THEN COALESCE(dispatched_at, $5) ELSE dispatched_at END,
      delivered_at = CASE WHEN $4 = 'delivered' THEN LEAST(delivered_at, $5) ELSE delivered_at END,
      error_code = CASE WHEN $4 = 'failed' THEN 'CAMPAIGN_PROVIDER_DELIVERY_FAILED' ELSE NULL END,
      error_message = CASE WHEN $4 = 'failed' THEN 'WhatsApp informó un fallo de entrega.' ELSE NULL END,
      updated_at = clock_timestamp()
    WHERE d.tenant_id = $1 AND d.id = $2
      AND ($5::timestamptz BETWEEN d.created_at - interval '5 minutes' AND $6::timestamptz + interval '5 minutes')
      AND $6::timestamptz <= d.created_at + interval '30 days'
      AND (d.provider_message_id IS NULL OR d.provider_message_id = $3)
      AND (d.status = 'pending' OR (d.status = 'dispatched' AND $4 IN ('failed', 'delivered'))
        OR (d.status = 'failed' AND $4 = 'delivered'))
      AND NOT EXISTS (SELECT 1 FROM campaign_deliveries other
        JOIN campaigns oc ON oc.id = other.campaign_id AND oc.tenant_id = other.tenant_id
        WHERE other.tenant_id = $1 AND oc.channel = 'whatsapp-cloud' AND other.provider_message_id = $3 AND other.id <> d.id)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE company_id = $1 AND channel = 'whatsapp' AND provider_message_id = $3)
  `, [tenantId, ref[1], providerId, next, occurredAt, event.received_at]);
  if (changed.rowCount) await refreshCampaignStats(db, tenantId, delivery.campaign_id);
}
