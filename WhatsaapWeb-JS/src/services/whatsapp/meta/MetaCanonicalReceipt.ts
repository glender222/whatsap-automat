import type { Queryable } from '../../../shared/UnitOfWorkPort';

const statusPriority = { accepted: 0, sent: 1, failed: 2, delivered: 3, read: 4 } as const;
type CanonicalMetaStatus = keyof typeof statusPriority;

function deliveryStatus(value: unknown): value is Exclude<CanonicalMetaStatus, 'accepted'> {
  return value === 'sent' || value === 'failed' || value === 'delivered' || value === 'read';
}

// The HTTP acknowledgement and the signed webhook can arrive in either order.
export async function lockMetaReceipt(db: Queryable, tenantId: number, providerId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('meta-receipt:' || $1::text || ':' || $2::text, 0))",
    [tenantId, providerId]);
}

export async function refreshConversationPreview(db: Queryable, tenantId: number, messageId: number): Promise<void> {
  await db.query(`
    UPDATE conversations c SET last_message_at = m.occurred_at, last_outbound_message_at = m.occurred_at,
      last_message_preview = m.body, last_message_direction = 'outbound', updated_at = clock_timestamp()
    FROM messages m WHERE c.company_id = $1 AND m.company_id = c.company_id AND m.id = $2
      AND c.id = m.conversation_id AND (c.last_message_at IS NULL OR c.last_message_at <= m.occurred_at)
  `, [tenantId, messageId]);
}

// Call within the signed-webhook transaction after recording the event and locking its provider ID.
export async function correlateCanonicalMetaStatus(
  db: Queryable, tenantId: number, providerId: string, eventId: string,
): Promise<void> {
  if (!/^wamid\.[A-Za-z0-9+/_=-]{1,249}$/.test(providerId)) return;
  const { rows: [event] } = await db.query(`
    SELECT phone_number_id, received_at, payload_json->'status' AS status
    FROM whatsapp_webhook_events
    WHERE company_id = $1 AND provider = 'meta-cloud' AND provider_message_id = $2 AND id = $3
      AND payload_json #>> '{metadata,phone_number_id}' = phone_number_id
  `, [tenantId, providerId, eventId]);
  const status = event?.status;
  if (!deliveryStatus(status?.status) || status.id !== providerId ||
      typeof status.recipient_id !== 'string' || typeof status.timestamp !== 'string' || !/^\d{1,11}$/.test(status.timestamp) ||
      typeof status.biz_opaque_callback_data !== 'string') return;
  const ref = /^automat:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(status.biz_opaque_callback_data);
  if (!ref) return;
  const occurredAt = new Date(Number(status.timestamp) * 1000);
  const { rows: [claim] } = await db.query(`
    UPDATE conversation_send_claims c SET state = 'provider_accepted', provider_message_id = $2, resolved_at = clock_timestamp()
    WHERE c.tenant_id = $1 AND c.callback_ref = $3::uuid AND c.state = 'unknown_delivery'
      AND c.phone_number_id = $4 AND c.recipient_id = $5 AND c.message_id IS NOT NULL
      AND $6::timestamptz BETWEEN c.claimed_at - interval '5 minutes' AND $7::timestamptz + interval '5 minutes'
      AND NOT EXISTS (SELECT 1 FROM conversation_send_claims WHERE tenant_id = $1 AND provider_message_id = $2)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE company_id = $1 AND channel = 'whatsapp' AND provider_message_id = $2)
    RETURNING message_id
  `, [tenantId, providerId, ref[1], event.phone_number_id, status.recipient_id, occurredAt, event.received_at]);
  if (!claim) return;

  await db.query(`
    UPDATE messages SET provider_message_id = $3, status = 'accepted',
      raw_payload_json = jsonb_build_object('providerMessageId', $3::varchar)
    WHERE company_id = $1 AND id = $2
  `, [tenantId, claim.message_id, providerId]);
  if (status.status !== 'failed') await refreshConversationPreview(db, tenantId, claim.message_id);
}

export async function applyCanonicalMetaStatuses(
  db: Queryable, tenantId: number, providerId: string, eventId: string | null = null,
): Promise<boolean> {
  const { rows: [claim] } = await db.query(`
    SELECT c.message_id, c.phone_number_id, c.recipient_id, c.claimed_at, c.callback_ref, m.status
    FROM conversation_send_claims c LEFT JOIN messages m ON m.company_id = c.tenant_id AND m.id = c.message_id
    WHERE c.tenant_id = $1 AND c.provider_message_id = $2
  `, [tenantId, providerId]);
  if (!claim) return false;
  if (!claim.message_id || !claim.status) return true;

  const { rows: events } = await db.query(`
    SELECT id, payload_json->'status' AS status, received_at
    FROM whatsapp_webhook_events
    WHERE company_id = $1 AND provider = 'meta-cloud' AND provider_message_id = $2
      AND phone_number_id = $3 AND event_type IN ('status.sent', 'status.failed', 'status.delivered', 'status.read')
      AND CASE WHEN $4::bigint IS NULL THEN processing_status = 'processed' ELSE id = $4 END
    ORDER BY received_at, id
  `, [tenantId, providerId, claim.phone_number_id, eventId]);

  let best = claim.status as CanonicalMetaStatus;
  for (const { id, status, received_at: receivedAt } of events) {
    const nextStatus: unknown = status?.status;
    if (!deliveryStatus(nextStatus) || status.recipient_id !== claim.recipient_id ||
        typeof status.timestamp !== 'string' || !/^\d{1,11}$/.test(status.timestamp)) continue;
    const ref = status.biz_opaque_callback_data;
    if (typeof ref === 'string' && ref.startsWith('automat:') && ref !== `automat:${claim.callback_ref}`) continue;
    const occurredAt = new Date(Number(status.timestamp) * 1000);
    if (occurredAt.getTime() < claim.claimed_at.getTime() - 300_000 ||
        occurredAt.getTime() > receivedAt.getTime() + 300_000) continue;

    await db.query(`
      INSERT INTO message_statuses (message_id, status, source, occurred_at, metadata_json, provider, provider_message_id)
      VALUES ($1, $2, 'meta-cloud', $3, jsonb_build_object('webhookEventId', $4::text), 'meta-cloud', $5)
      ON CONFLICT DO NOTHING
    `, [claim.message_id, nextStatus, occurredAt, id, providerId]);
    await db.query(`
      UPDATE messages
      SET delivered_at = CASE WHEN $3 = 'delivered' THEN LEAST(delivered_at, $4) ELSE delivered_at END,
          read_at = CASE WHEN $3 = 'read' THEN LEAST(read_at, $4) ELSE read_at END,
          failed_at = CASE WHEN $3 = 'failed' THEN LEAST(failed_at, $4) ELSE failed_at END
      WHERE company_id = $1 AND id = $2
    `, [tenantId, claim.message_id, nextStatus, occurredAt]);
    if (statusPriority[nextStatus] > (statusPriority[best] ?? -1)) best = nextStatus;
  }
  if (best !== claim.status) {
    await db.query('UPDATE messages SET status = $3 WHERE company_id = $1 AND id = $2', [tenantId, claim.message_id, best]);
  }
  return true;
}
