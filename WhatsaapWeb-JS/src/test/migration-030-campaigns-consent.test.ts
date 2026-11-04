import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

describe('PR-F6-02: Migration 030 Campaigns & Consent DDL and RLS Verification', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../db/migrations/030_create_campaigns_and_consent.sql'
  );

  test('Migration 030 file exists on filesystem', () => {
    assert.ok(fs.existsSync(migrationPath), `Migration file not found at ${migrationPath}`);
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  describe('Suite 1: Static DDL & Schema Verification', () => {
    test('1.1: Defines table consent_records with required columns and constraints', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS consent_records/i);
      assert.match(sqlContent, /id VARCHAR\(255\) PRIMARY KEY/i);
      assert.match(sqlContent, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\)/i);
      assert.match(sqlContent, /channel_type VARCHAR\(50\) NOT NULL/i);
      assert.match(sqlContent, /destination VARCHAR\(255\) NOT NULL/i);
      assert.match(sqlContent, /purpose VARCHAR\(100\) NOT NULL DEFAULT 'marketing'/i);
      assert.match(sqlContent, /status VARCHAR\(50\) NOT NULL DEFAULT 'opted_in'/i);
      assert.match(sqlContent, /evidence_type VARCHAR\(100\) NOT NULL DEFAULT 'manual'/i);
      assert.match(sqlContent, /uq_consent_records_tenant_channel_dest_purpose[\s\S]*?UNIQUE/i);
      assert.match(sqlContent, /chk_consent_records_status/i);
      assert.match(sqlContent, /chk_consent_records_purpose/i);
      assert.match(sqlContent, /chk_consent_records_evidence/i);
    });

    test('1.2: Defines table segments with criteria_json and unique name constraint', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS segments/i);
      assert.match(sqlContent, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\)/i);
      assert.match(sqlContent, /target_channel VARCHAR\(50\) NOT NULL DEFAULT 'any'/i);
      assert.match(sqlContent, /criteria_json JSONB NOT NULL DEFAULT/i);
      assert.match(sqlContent, /dynamic BOOLEAN NOT NULL DEFAULT TRUE/i);
      assert.match(sqlContent, /calculated_count INTEGER NOT NULL DEFAULT 0/i);
      assert.match(sqlContent, /uq_segments_tenant_name UNIQUE \(tenant_id, name\)/i);
    });

    test('1.3: Defines table campaigns with pacing, circuit breaker and status constraints', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS campaigns/i);
      assert.match(sqlContent, /rate_limit_per_minute INTEGER NOT NULL DEFAULT 50/i);
      assert.match(sqlContent, /failure_pause_threshold_percent NUMERIC\(5,2\) NOT NULL DEFAULT 5\.00/i);
      assert.match(sqlContent, /chk_campaigns_status/i);
      assert.match(sqlContent, /chk_campaigns_rate_limit/i);
      assert.match(sqlContent, /chk_campaigns_threshold/i);
    });

    test('1.4: Defines table campaign_deliveries with idempotency uniqueness', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS campaign_deliveries/i);
      assert.match(sqlContent, /campaign_id VARCHAR\(255\) NOT NULL REFERENCES campaigns\(id\)/i);
      assert.match(sqlContent, /uq_campaign_deliveries_idempotency UNIQUE \(tenant_id, idempotency_key\)/i);
      assert.match(sqlContent, /uq_campaign_deliveries_campaign_dest UNIQUE \(campaign_id, destination\)/i);
      assert.match(sqlContent, /chk_campaign_deliveries_status/i);
    });

    test('1.5: Enforces indexes for high-throughput lookup and suppression filtering', () => {
      assert.match(sqlContent, /idx_consent_records_lookup/i);
      assert.match(sqlContent, /idx_consent_records_suppressed/i);
      assert.match(sqlContent, /idx_segments_tenant_channel/i);
      assert.match(sqlContent, /idx_campaigns_tenant_status/i);
      assert.match(sqlContent, /idx_campaign_deliveries_campaign_status/i);
    });
  });

  describe('Suite 2: Multi-Tenant RLS Policy Verification', () => {
    test('2.1: Enforces ENABLE and FORCE ROW LEVEL SECURITY across all 4 tables', () => {
      assert.match(sqlContent, /ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;/i);

      assert.match(sqlContent, /ALTER TABLE segments ENABLE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /ALTER TABLE segments FORCE ROW LEVEL SECURITY;/i);

      assert.match(sqlContent, /ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;/i);

      assert.match(sqlContent, /ALTER TABLE campaign_deliveries ENABLE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /ALTER TABLE campaign_deliveries FORCE ROW LEVEL SECURITY;/i);
    });

    test('2.2: Creates tenant_isolation_policy on all 4 tables checking app.current_tenant_id', () => {
      const tables = ['consent_records', 'segments', 'campaigns', 'campaign_deliveries'];
      for (const table of tables) {
        const regex = new RegExp(
          `CREATE POLICY tenant_isolation_policy ON ${table}[\\s\\S]*?USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\)`,
          'i'
        );
        assert.match(sqlContent, regex, `Missing tenant isolation policy for ${table}`);
      }
    });
  });
});
