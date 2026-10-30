-- WhatsApp Business / Meta Cloud API inbox expansion.
-- Design goals:
-- - Postgres remains the source of truth for the inbox/history.
-- - Webhook ingestion is idempotent.
-- - Common inbox queries are covered by compound indexes.
-- - Meta payloads are retained in JSONB without making JSONB the primary model.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Provider/account configuration. Tokens are not stored here; use token_secret_ref
-- to point to an environment secret or vault entry.
CREATE TABLE IF NOT EXISTS whatsapp_business_accounts (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL DEFAULT 'meta-cloud',
  waba_id VARCHAR(100),
  phone_number_id VARCHAR(100) NOT NULL,
  display_phone_number VARCHAR(50),
  business_phone_number VARCHAR(50),
  graph_version VARCHAR(20) NOT NULL DEFAULT 'v25.0',
  token_secret_ref VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'configured',
  quality_rating VARCHAR(50),
  messaging_limit_tier VARCHAR(100),
  last_verified_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_whatsapp_accounts_company_provider_phone
    UNIQUE (company_id, provider, phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_company_status
ON whatsapp_business_accounts(company_id, status);

-- Webhook event ledger for replay protection, debugging and dead-letter handling.
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'meta-cloud',
  phone_number_id VARCHAR(100),
  event_type VARCHAR(80) NOT NULL,
  event_dedupe_key VARCHAR(255) NOT NULL,
  provider_message_id VARCHAR(255),
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  processing_status VARCHAR(50) NOT NULL DEFAULT 'received',
  error_message TEXT,
  CONSTRAINT uq_whatsapp_webhook_events_dedupe
    UNIQUE (company_id, provider, event_dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_status_received
ON whatsapp_webhook_events(processing_status, received_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_provider_message
ON whatsapp_webhook_events(company_id, provider, provider_message_id)
WHERE provider_message_id IS NOT NULL;

-- Templates are required when the 24h customer service window is closed.
CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL DEFAULT 'meta-cloud',
  waba_id VARCHAR(100),
  template_name VARCHAR(255) NOT NULL,
  language_code VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  status VARCHAR(50),
  components_json JSONB NOT NULL DEFAULT '[]',
  external_template_id VARCHAR(255),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_whatsapp_templates_company_name_lang
    UNIQUE (company_id, provider, template_name, language_code)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_company_status
ON whatsapp_message_templates(company_id, status, category);

-- Contacts: keep normalized searchable fields next to raw Meta profile data.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS wa_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS profile_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_contacts_company_phone
ON contacts(company_id, phone)
WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_company_wa_id
ON contacts(company_id, wa_id)
WHERE wa_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_company_name_trgm
ON contacts USING GIN ((COALESCE(display_name, name, profile_name, '')) gin_trgm_ops);

-- Conversations: service-window fields make Meta's send rules explicit.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS assigned_user_id INT,
  ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS service_window_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_outbound_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_preview TEXT,
  ADD COLUMN IF NOT EXISTS last_message_direction VARCHAR(20),
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_conversations_inbox_open
ON conversations(company_id, channel, status, last_message_at DESC NULLS LAST, id DESC)
WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_service_window
ON conversations(company_id, service_window_expires_at)
WHERE service_window_expires_at IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_contact
ON conversations(company_id, contact_id)
WHERE contact_id IS NOT NULL;

-- Messages: normalized fields support fast rendering, status updates, search and
-- safe retries. raw_payload_json remains available for Meta-specific details.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS external_contact_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS template_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS template_language VARCHAR(20),
  ADD COLUMN IF NOT EXISTS template_category VARCHAR(50),
  ADD COLUMN IF NOT EXISTS pricing_category VARCHAR(50),
  ADD COLUMN IF NOT EXISTS media_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS is_echo BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('spanish', COALESCE(body, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_timeline
ON messages(conversation_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_company_timeline
ON messages(company_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_company_provider_message
ON messages(company_id, channel, provider_message_id)
WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_company_client_request
ON messages(company_id, client_request_id)
WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_search_vector
ON messages USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_messages_body_trgm
ON messages USING GIN (body gin_trgm_ops)
WHERE body IS NOT NULL;

-- Attachments: Meta media IDs and local cache status.
ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_media_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sha256 VARCHAR(128),
  ADD COLUMN IF NOT EXISTS caption TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INT,
  ADD COLUMN IF NOT EXISTS storage_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS downloaded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_attachments_provider_media
ON message_attachments(provider, provider_media_id)
WHERE provider_media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_storage_status
ON message_attachments(storage_status, created_at);

-- Statuses: make webhook duplicates harmless.
ALTER TABLE message_statuses
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS raw_payload_json JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_statuses_event
ON message_statuses(message_id, status, occurred_at)
WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_statuses_provider_message
ON message_statuses(provider, provider_message_id, occurred_at DESC)
WHERE provider_message_id IS NOT NULL;

-- Audit logs are frequently filtered by action/entity during support.
CREATE INDEX IF NOT EXISTS idx_audit_entity
ON audit_logs(company_id, entity_type, entity_id, created_at DESC);
