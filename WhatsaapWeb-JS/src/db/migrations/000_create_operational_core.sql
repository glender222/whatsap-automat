-- Operational Core base schema.
-- Additive-only and idempotent: safe for fresh databases and existing installs.
-- This migration mirrors the runtime CoreModel DDL so schema creation is repeatable
-- through the formal migration pipeline.

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO companies (id, name)
VALUES (1, 'Default Company')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel VARCHAR(50) NOT NULL,
  external_contact_id VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  phone VARCHAR(50),
  raw_profile_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_contacts_company_channel_external
    UNIQUE (company_id, channel, external_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_company_external
ON contacts(company_id, channel, external_contact_id);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel VARCHAR(50) NOT NULL,
  external_conversation_id VARCHAR(255) NOT NULL,
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  type VARCHAR(50),
  title VARCHAR(255),
  last_message_at TIMESTAMPTZ,
  unread_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_conversations_company_channel_external
    UNIQUE (company_id, channel, external_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_company_last_message
ON conversations(company_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
  direction VARCHAR(20) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  provider_message_id VARCHAR(255),
  client_request_id VARCHAR(255),
  body TEXT,
  message_type VARCHAR(50),
  status VARCHAR(50),
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  raw_payload_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_messages_company_channel_provider_id
    UNIQUE (company_id, channel, provider_message_id),
  CONSTRAINT uq_messages_company_client_request_id
    UNIQUE (company_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_occurred
ON messages(conversation_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_company_provider
ON messages(company_id, channel, provider_message_id);

CREATE TABLE IF NOT EXISTS message_attachments (
  id SERIAL PRIMARY KEY,
  message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename VARCHAR(255),
  mime_type VARCHAR(100),
  size_bytes INT,
  external_url TEXT,
  internal_path TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_message_id
ON message_attachments(message_id);

CREATE TABLE IF NOT EXISTS message_statuses (
  id SERIAL PRIMARY KEY,
  message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL,
  source VARCHAR(50),
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  metadata_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statuses_message_id
ON message_statuses(message_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id) ON DELETE SET NULL,
  actor VARCHAR(255),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id VARCHAR(255),
  metadata_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_company_created
ON audit_logs(company_id, created_at DESC);
