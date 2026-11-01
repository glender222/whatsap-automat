-- Migration 022: Enable PostgreSQL Row-Level Security (RLS) on all multi-tenant tables
-- Specification: PR-F1-02 (WAA-003, SEC-001..SEC-004, ADR-002)
-- Policy: AS PERMISSIVE enforcing company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer

-- -----------------------------------------------------------------------------
-- 1. Core Messaging Tables
-- -----------------------------------------------------------------------------

-- contacts
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON contacts;
CREATE POLICY tenant_isolation_policy ON contacts
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON conversations;
CREATE POLICY tenant_isolation_policy ON conversations
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON messages;
CREATE POLICY tenant_isolation_policy ON messages
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- whatsapp_business_accounts
ALTER TABLE whatsapp_business_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_business_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON whatsapp_business_accounts;
CREATE POLICY tenant_isolation_policy ON whatsapp_business_accounts
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- whatsapp_webhook_events
ALTER TABLE whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON whatsapp_webhook_events;
CREATE POLICY tenant_isolation_policy ON whatsapp_webhook_events
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- whatsapp_message_templates
ALTER TABLE whatsapp_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_message_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON whatsapp_message_templates;
CREATE POLICY tenant_isolation_policy ON whatsapp_message_templates
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 2. Operational & Audit Tables
-- -----------------------------------------------------------------------------

-- audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON audit_logs;
CREATE POLICY tenant_isolation_policy ON audit_logs
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- customer_orders
ALTER TABLE customer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON customer_orders;
CREATE POLICY tenant_isolation_policy ON customer_orders
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- operational_actions
ALTER TABLE operational_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON operational_actions;
CREATE POLICY tenant_isolation_policy ON operational_actions
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- order_items
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON order_items;
CREATE POLICY tenant_isolation_policy ON order_items
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- stock_movements
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON stock_movements;
CREATE POLICY tenant_isolation_policy ON stock_movements
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- handoff_tickets
ALTER TABLE handoff_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_tickets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON handoff_tickets;
CREATE POLICY tenant_isolation_policy ON handoff_tickets
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- ia_pause_overrides
ALTER TABLE ia_pause_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE ia_pause_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ia_pause_overrides;
CREATE POLICY tenant_isolation_policy ON ia_pause_overrides
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 3. Commercial Catalog & Inventory Tables
-- -----------------------------------------------------------------------------

-- products
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON products;
CREATE POLICY tenant_isolation_policy ON products
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- catalogs
ALTER TABLE catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON catalogs;
CREATE POLICY tenant_isolation_policy ON catalogs
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- catalog_items
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON catalog_items;
CREATE POLICY tenant_isolation_policy ON catalog_items
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- catalog_sections
ALTER TABLE catalog_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_sections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON catalog_sections;
CREATE POLICY tenant_isolation_policy ON catalog_sections
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- product_images
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON product_images;
CREATE POLICY tenant_isolation_policy ON product_images
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 4. Payments & Billing Tables
-- -----------------------------------------------------------------------------

-- payment_vouchers
ALTER TABLE payment_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON payment_vouchers;
CREATE POLICY tenant_isolation_policy ON payment_vouchers
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- payment_gateways
ALTER TABLE payment_gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateways FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON payment_gateways;
CREATE POLICY tenant_isolation_policy ON payment_gateways
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- payment_webhook_events
ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON payment_webhook_events;
CREATE POLICY tenant_isolation_policy ON payment_webhook_events
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 5. AI Agents & Session Tables
-- -----------------------------------------------------------------------------

-- ai_agents
ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ai_agents;
CREATE POLICY tenant_isolation_policy ON ai_agents
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- agent_test_runs
ALTER TABLE agent_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_test_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON agent_test_runs;
CREATE POLICY tenant_isolation_policy ON agent_test_runs
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

CREATE INDEX IF NOT EXISTS idx_agent_test_runs_company_id
ON agent_test_runs(company_id);

-- agent_runtime_logs
ALTER TABLE agent_runtime_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON agent_runtime_logs;
CREATE POLICY tenant_isolation_policy ON agent_runtime_logs
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- company_ai_domains
ALTER TABLE company_ai_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_ai_domains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON company_ai_domains;
CREATE POLICY tenant_isolation_policy ON company_ai_domains
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- ai_chat_sessions
ALTER TABLE ai_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ai_chat_sessions;
CREATE POLICY tenant_isolation_policy ON ai_chat_sessions
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- ai_session_turns
ALTER TABLE ai_session_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_session_turns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ai_session_turns;
CREATE POLICY tenant_isolation_policy ON ai_session_turns
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- ai_session_events
ALTER TABLE ai_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_session_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ai_session_events;
CREATE POLICY tenant_isolation_policy ON ai_session_events
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 6. Classification & Tag Tables
-- -----------------------------------------------------------------------------

-- tags
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tags;
CREATE POLICY tenant_isolation_policy ON tags
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- tag_chats
ALTER TABLE tag_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_chats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tag_chats;
CREATE POLICY tenant_isolation_policy ON tag_chats
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- tag_users
ALTER TABLE tag_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tag_users;
CREATE POLICY tenant_isolation_policy ON tag_users
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 7. Settings & Limits Tables
-- -----------------------------------------------------------------------------

-- company_settings
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON company_settings;
CREATE POLICY tenant_isolation_policy ON company_settings
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- company_limits
ALTER TABLE company_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON company_limits;
CREATE POLICY tenant_isolation_policy ON company_limits
  AS PERMISSIVE
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 8. Conditional Runtime Table: usuarios
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'usuarios') THEN
    ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
    ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_policy ON usuarios;
    CREATE POLICY tenant_isolation_policy ON usuarios
      AS PERMISSIVE
      USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
      WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
  END IF;
END $$;

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON contacts;
-- ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE contacts DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON conversations;
-- ALTER TABLE conversations NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON messages;
-- ALTER TABLE messages NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE messages DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON whatsapp_business_accounts;
-- ALTER TABLE whatsapp_business_accounts NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE whatsapp_business_accounts DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON whatsapp_webhook_events;
-- ALTER TABLE whatsapp_webhook_events NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE whatsapp_webhook_events DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON whatsapp_message_templates;
-- ALTER TABLE whatsapp_message_templates NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE whatsapp_message_templates DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON audit_logs;
-- ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON customer_orders;
-- ALTER TABLE customer_orders NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE customer_orders DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON operational_actions;
-- ALTER TABLE operational_actions NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE operational_actions DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON order_items;
-- ALTER TABLE order_items NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE order_items DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON stock_movements;
-- ALTER TABLE stock_movements NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE stock_movements DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON handoff_tickets;
-- ALTER TABLE handoff_tickets NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE handoff_tickets DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON ia_pause_overrides;
-- ALTER TABLE ia_pause_overrides NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ia_pause_overrides DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON products;
-- ALTER TABLE products NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE products DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON catalogs;
-- ALTER TABLE catalogs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE catalogs DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON catalog_items;
-- ALTER TABLE catalog_items NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE catalog_items DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON catalog_sections;
-- ALTER TABLE catalog_sections NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE catalog_sections DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON product_images;
-- ALTER TABLE product_images NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE product_images DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON payment_vouchers;
-- ALTER TABLE payment_vouchers NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE payment_vouchers DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON payment_gateways;
-- ALTER TABLE payment_gateways NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE payment_gateways DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON payment_webhook_events;
-- ALTER TABLE payment_webhook_events NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE payment_webhook_events DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON ai_agents;
-- ALTER TABLE ai_agents NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ai_agents DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON agent_test_runs;
-- ALTER TABLE agent_test_runs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE agent_test_runs DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS idx_agent_test_runs_company_id;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON agent_runtime_logs;
-- ALTER TABLE agent_runtime_logs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE agent_runtime_logs DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON company_ai_domains;
-- ALTER TABLE company_ai_domains NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE company_ai_domains DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON ai_chat_sessions;
-- ALTER TABLE ai_chat_sessions NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ai_chat_sessions DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON ai_session_turns;
-- ALTER TABLE ai_session_turns NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ai_session_turns DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON ai_session_events;
-- ALTER TABLE ai_session_events NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ai_session_events DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tags;
-- ALTER TABLE tags NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tags DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tag_chats;
-- ALTER TABLE tag_chats NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tag_chats DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tag_users;
-- ALTER TABLE tag_users NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tag_users DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON company_settings;
-- ALTER TABLE company_settings NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE company_settings DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON company_limits;
-- ALTER TABLE company_limits NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE company_limits DISABLE ROW LEVEL SECURITY;
--
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'usuarios') THEN
--     DROP POLICY IF EXISTS tenant_isolation_policy ON usuarios;
--     ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
--     ALTER TABLE usuarios DISABLE ROW LEVEL SECURITY;
--   END IF;
-- END $$;
-- =============================================================================
