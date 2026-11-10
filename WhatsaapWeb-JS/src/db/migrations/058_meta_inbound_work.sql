-- Discovery contains tenant IDs only; message content stays behind the existing
-- tenant-scoped outbox/messages RLS policies.
CREATE TABLE IF NOT EXISTS meta_inbound_work_tenants (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE meta_inbound_work_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_inbound_work_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_inbound_work_tenants_read ON meta_inbound_work_tenants
  FOR SELECT USING (true);
CREATE POLICY meta_inbound_work_tenants_insert ON meta_inbound_work_tenants
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

CREATE INDEX IF NOT EXISTS idx_processing_outbox_meta_inbound_poll
  ON processing_outbox (tenant_id, next_retry_at, created_at, id)
  WHERE event_type = 'whatsapp.inbound.received'
    AND status IN ('pending', 'processing', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_inbound_active_conversation
  ON processing_outbox (tenant_id, (payload->>'conversationId'))
  WHERE event_type = 'whatsapp.inbound.received' AND status IN ('processing', 'dispatched');

CREATE INDEX IF NOT EXISTS idx_meta_inbound_conversation_order
  ON processing_outbox (tenant_id, (payload->>'conversationId'), created_at, id)
  WHERE event_type = 'whatsapp.inbound.received'
    AND status IN ('pending', 'processing', 'dispatched');
