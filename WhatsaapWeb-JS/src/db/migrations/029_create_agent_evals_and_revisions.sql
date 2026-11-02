-- Migration 029: RAG Memory (pgvector) & Agent Regression Evaluation Suites and Runs
-- Specification: Milestone M3 / PR-F5-03 (WAA-013, ADR-009, ADR-010, ADR-0010)
-- Description: Establishes knowledge_collections and knowledge_chunks for tenant-isolated
--              pgvector RAG semantic memory, along with agent_eval_suites and agent_eval_runs
--              for deterministic dry-run regression evaluations with strict PostgreSQL RLS.

-- -----------------------------------------------------------------------------
-- 1. pgvector Extension and Vector Storage
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Extension vector could not be created or already exists: %', SQLERRM;
END $$;

-- -----------------------------------------------------------------------------
-- 2. RAG Knowledge Collections & Chunks
-- -----------------------------------------------------------------------------

-- 2.1 knowledge_collections: Tenant vector collections with distance metric & chunk config
CREATE TABLE IF NOT EXISTS knowledge_collections (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  embedding_model VARCHAR(120) NOT NULL DEFAULT 'text-embedding-3-small',
  distance_metric VARCHAR(30) NOT NULL DEFAULT 'cosine',
  chunk_strategy JSONB NOT NULL DEFAULT '{"chunkSizeTokens": 512, "overlapTokens": 64, "strategy": "sliding_window"}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_knowledge_collections_tenant_name UNIQUE (tenant_id, name),
  CONSTRAINT chk_knowledge_collections_metric CHECK (
    distance_metric IN ('cosine', 'l2', 'inner_product')
  )
);

CREATE INDEX IF NOT EXISTS idx_knowledge_collections_tenant
ON knowledge_collections(tenant_id, created_at DESC);

-- 2.2 knowledge_chunks: Vectorized document chunks with customer tracking & pgvector embedding
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id VARCHAR(255) PRIMARY KEY,
      collection_id VARCHAR(255) NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      document_id VARCHAR(255),
      customer_id VARCHAR(255),
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content_text TEXT NOT NULL,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding vector(1536),
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  ELSE
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id VARCHAR(255) PRIMARY KEY,
      collection_id VARCHAR(255) NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      document_id VARCHAR(255),
      customer_id VARCHAR(255),
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content_text TEXT NOT NULL,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      embedding JSONB,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_collection
ON knowledge_chunks(tenant_id, collection_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_customer
ON knowledge_chunks(tenant_id, customer_id)
WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_doc
ON knowledge_chunks(tenant_id, document_id)
WHERE document_id IS NOT NULL;

-- Vector HNSW indexes (applied conditionally when pgvector extension type is active)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_cosine ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_l2 ON knowledge_chunks USING hnsw (embedding vector_l2_ops)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Vector indexes could not be created or already exist: %', SQLERRM;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Agent Evaluation Suites & Runs
-- -----------------------------------------------------------------------------

-- 3.1 agent_eval_suites: Storage for benchmark scenario test suites
CREATE TABLE IF NOT EXISTS agent_eval_suites (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_graph_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  pass_threshold_percent NUMERIC(5,2) NOT NULL DEFAULT 95.00,
  scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  baseline_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agent_eval_suites_threshold CHECK (
    pass_threshold_percent >= 0.00 AND pass_threshold_percent <= 100.00
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_eval_suites_tenant_agent
ON agent_eval_suites(tenant_id, agent_graph_id);

-- 3.2 agent_eval_runs: Execution scorecard history
CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  suite_id VARCHAR(255) NOT NULL REFERENCES agent_eval_suites(id) ON DELETE CASCADE,
  agent_graph_id VARCHAR(255) NOT NULL,
  graph_version INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'completed',
  passed BOOLEAN NOT NULL DEFAULT false,
  pass_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  p50_latency_ms INTEGER NOT NULL DEFAULT 0,
  p95_latency_ms INTEGER NOT NULL DEFAULT 0,
  total_cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  total_tokens_used INTEGER NOT NULL DEFAULT 0,
  regression_detected BOOLEAN NOT NULL DEFAULT false,
  security_tool_leaks TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  scorecard JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agent_eval_runs_status CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_lookup
ON agent_eval_runs(tenant_id, suite_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Row-Level Security (RLS) Enablement & Strict Isolation Policies
-- -----------------------------------------------------------------------------

-- 4.1 knowledge_collections RLS
ALTER TABLE knowledge_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_collections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON knowledge_collections;
CREATE POLICY tenant_isolation_policy ON knowledge_collections
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 4.2 knowledge_chunks RLS
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON knowledge_chunks;
CREATE POLICY tenant_isolation_policy ON knowledge_chunks
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 4.3 agent_eval_suites RLS
ALTER TABLE agent_eval_suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_eval_suites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON agent_eval_suites;
CREATE POLICY tenant_isolation_policy ON agent_eval_suites
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 4.4 agent_eval_runs RLS
ALTER TABLE agent_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_eval_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON agent_eval_runs;
CREATE POLICY tenant_isolation_policy ON agent_eval_runs
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION:
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON agent_eval_runs;
-- ALTER TABLE agent_eval_runs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE agent_eval_runs DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS agent_eval_runs CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON agent_eval_suites;
-- ALTER TABLE agent_eval_suites NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE agent_eval_suites DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS agent_eval_suites CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON knowledge_chunks;
-- ALTER TABLE knowledge_chunks NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE knowledge_chunks DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS knowledge_chunks CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON knowledge_collections;
-- ALTER TABLE knowledge_collections NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE knowledge_collections DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS knowledge_collections CASCADE;
-- =============================================================================
