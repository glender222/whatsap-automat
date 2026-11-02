-- Migration 028: ToolBroker Security Barrier, Agent Tool Grants & HITL Approvals
-- Specification: Milestone M2 / PR-F5-02 (WAA-012, SEC-007, ADR-012, ADR-0008)
-- Description: Establishes tool_definitions catalog, tenant-scoped agent_tool_grants,
--              durable approval_requests for HITL financial/destructive gates,
--              and tool_execution_effects idempotency store with strict PostgreSQL RLS.

-- -----------------------------------------------------------------------------
-- 1. Table Definitions
-- -----------------------------------------------------------------------------

-- 1.1 tool_definitions: System standard tools and custom tenant tools
CREATE TABLE IF NOT EXISTS tool_definitions (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  risk_level VARCHAR(30) NOT NULL,
  required_roles TEXT[] NOT NULL DEFAULT ARRAY['agent']::text[],
  parameters_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  is_egress_network BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  requires_cas_fencing BOOLEAN NOT NULL DEFAULT false,
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_tool_definitions_risk_level CHECK (
    risk_level IN ('read', 'write', 'send', 'financial', 'destructive')
  ),
  CONSTRAINT chk_tool_definitions_timeout CHECK (
    timeout_ms >= 500 AND timeout_ms <= 60000
  )
);

-- Partial unique indexes to support global built-in tools (tenant_id IS NULL)
-- as well as tenant-specific custom tool definitions
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_definitions_builtin_name
ON tool_definitions(name) WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_definitions_tenant_name
ON tool_definitions(tenant_id, name) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tool_definitions_tenant_active
ON tool_definitions(tenant_id, is_active, risk_level);

-- 1.2 agent_tool_grants: RBAC permissions granting tools to agents/tenants
CREATE TABLE IF NOT EXISTS agent_tool_grants (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_graph_id VARCHAR(255),
  tool_name VARCHAR(120) NOT NULL,
  required_roles TEXT[] NOT NULL DEFAULT ARRAY['agent']::text[],
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  limits_override JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_agent_tool_grants_tenant_agent_tool UNIQUE (tenant_id, agent_graph_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_grants_lookup
ON agent_tool_grants(tenant_id, tool_name, is_enabled);

-- 1.3 approval_requests: Durable store for Human-In-The-Loop approvals
CREATE TABLE IF NOT EXISTS approval_requests (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  run_id VARCHAR(255) NOT NULL,
  agent_graph_id VARCHAR(255),
  node_id VARCHAR(255),
  tool_name VARCHAR(120) NOT NULL,
  effect_key VARCHAR(255) NOT NULL,
  proposed_action_hash VARCHAR(64) NOT NULL,
  risk VARCHAR(30) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  redacted_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_conversation_version INTEGER,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by VARCHAR(255),
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_approval_requests_risk CHECK (
    risk IN ('read', 'write', 'send', 'financial', 'destructive', 'low', 'medium', 'high')
  ),
  CONSTRAINT chk_approval_requests_status CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired', 'revoked', 'cancelled')
  ),
  CONSTRAINT chk_approval_requests_version CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_tenant_status
ON approval_requests(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_effect_key
ON approval_requests(tenant_id, effect_key);

CREATE INDEX IF NOT EXISTS idx_approval_requests_run_node
ON approval_requests(tenant_id, run_id, node_id);

-- 1.4 tool_execution_effects: Durable idempotency cache store
CREATE TABLE IF NOT EXISTS tool_execution_effects (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  effect_key VARCHAR(255) NOT NULL,
  run_id VARCHAR(255) NOT NULL,
  tool_name VARCHAR(120) NOT NULL,
  status VARCHAR(30) NOT NULL,
  output JSONB,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tool_execution_effects UNIQUE (tenant_id, effect_key)
);

CREATE INDEX IF NOT EXISTS idx_tool_execution_effects_lookup
ON tool_execution_effects(tenant_id, effect_key);

-- -----------------------------------------------------------------------------
-- 2. Seed Standard Built-In Tool Definitions (Global, tenant_id IS NULL)
-- -----------------------------------------------------------------------------

INSERT INTO tool_definitions (
  id, tenant_id, name, display_name, description, risk_level, required_roles,
  parameters_schema, timeout_ms, is_egress_network, requires_approval, requires_cas_fencing, is_builtin, is_active
) VALUES
(
  'tool_builtin_http_request',
  NULL,
  'http_request',
  'HTTP Request with SSRF Firewall',
  'Performs an external HTTP or HTTPS request protected by the bitwise CIDR SSRF egress firewall.',
  'write',
  ARRAY['agent', 'admin']::text[],
  '{"type":"object","required":["url"],"properties":{"url":{"type":"string","format":"uri"},"method":{"type":"string","enum":["GET","POST","PUT","DELETE","PATCH"],"default":"GET"},"headers":{"type":"object"},"body":{"type":["string","object"]},"timeoutMs":{"type":"integer","minimum":500,"maximum":30000,"default":5000}}}'::jsonb,
  10000,
  true,
  false,
  false,
  true,
  true
),
(
  'tool_builtin_search_knowledge',
  NULL,
  'search_knowledge',
  'Search Knowledge Base (RAG)',
  'Performs semantic similarity vector search over the tenant-isolated pgvector knowledge base.',
  'read',
  ARRAY['agent', 'operator']::text[],
  '{"type":"object","required":["query"],"properties":{"query":{"type":"string","minLength":1},"collectionId":{"type":"string"},"topK":{"type":"integer","minimum":1,"maximum":10,"default":3},"minSimilarity":{"type":"number","minimum":0,"maximum":1,"default":0.7}}}'::jsonb,
  5000,
  false,
  false,
  false,
  true,
  true
),
(
  'tool_builtin_send_whatsapp_message',
  NULL,
  'send_whatsapp_message',
  'Send WhatsApp Message (CAS Fenced)',
  'Sends an outbound message to a WhatsApp conversation with CAS anti-takeover fencing validation.',
  'send',
  ARRAY['agent', 'operator']::text[],
  '{"type":"object","required":["conversationId","messageText"],"properties":{"conversationId":{"type":["integer","string"]},"recipientPhone":{"type":"string"},"messageText":{"type":"string","minLength":1,"maxLength":4096},"expectedConversationVersion":{"type":"integer","minimum":0}}}'::jsonb,
  8000,
  false,
  false,
  true,
  true,
  true
),
(
  'tool_builtin_create_invoice',
  NULL,
  'create_invoice',
  'Create Customer Invoice (HITL Approval Gate)',
  'Generates a binding commercial invoice and payment request. Requires supervisor human approval.',
  'financial',
  ARRAY['agent', 'admin', 'supervisor']::text[],
  '{"type":"object","required":["customerId","items"],"properties":{"customerId":{"type":"string"},"customerEmail":{"type":"string"},"currency":{"type":"string","default":"USD"},"items":{"type":"array","items":{"type":"object","required":["description","quantity","unitAmountCents"],"properties":{"description":{"type":"string"},"quantity":{"type":"integer","minimum":1},"unitAmountCents":{"type":"integer","minimum":1}}}}}}'::jsonb,
  15000,
  false,
  true,
  false,
  true,
  true
)
ON CONFLICT (name) WHERE tenant_id IS NULL DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  risk_level = EXCLUDED.risk_level,
  required_roles = EXCLUDED.required_roles,
  parameters_schema = EXCLUDED.parameters_schema,
  timeout_ms = EXCLUDED.timeout_ms,
  is_egress_network = EXCLUDED.is_egress_network,
  requires_approval = EXCLUDED.requires_approval,
  requires_cas_fencing = EXCLUDED.requires_cas_fencing,
  updated_at = NOW();

-- -----------------------------------------------------------------------------
-- 3. Row-Level Security (RLS) Enablement & Strict Isolation Policies
-- -----------------------------------------------------------------------------

-- 3.1 tool_definitions RLS: Global built-in tools (tenant_id IS NULL) are readable
-- by all tenants; tenant-specific tools are isolated by tenant_id.
ALTER TABLE tool_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tool_definitions;
CREATE POLICY tenant_isolation_policy ON tool_definitions
  AS PERMISSIVE
  USING (
    tenant_id IS NULL OR
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  );

-- 3.2 agent_tool_grants RLS
ALTER TABLE agent_tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON agent_tool_grants;
CREATE POLICY tenant_isolation_policy ON agent_tool_grants
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 3.3 approval_requests RLS
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON approval_requests;
CREATE POLICY tenant_isolation_policy ON approval_requests
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 3.4 tool_execution_effects RLS
ALTER TABLE tool_execution_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_execution_effects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tool_execution_effects;
CREATE POLICY tenant_isolation_policy ON tool_execution_effects
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION:
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tool_execution_effects;
-- ALTER TABLE tool_execution_effects NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tool_execution_effects DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS tool_execution_effects CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON approval_requests;
-- ALTER TABLE approval_requests NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE approval_requests DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS approval_requests CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON agent_tool_grants;
-- ALTER TABLE agent_tool_grants NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE agent_tool_grants DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS agent_tool_grants CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tool_definitions;
-- ALTER TABLE tool_definitions NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tool_definitions DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS tool_definitions CASCADE;
-- =============================================================================
