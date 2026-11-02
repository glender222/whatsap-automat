import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelCompletionRequestV1Schema,
  modelCompletionResultV1Schema,
  byokCredentialV1Schema,
  byokCredentialSummaryV1Schema,
  registerByokCredentialCommandV1Schema,
  testByokConnectionRequestV1Schema,
  testByokConnectionResultV1Schema,
  tokenLedgerEntryV1Schema,
  createTokenLedgerEntryCommandV1Schema,
  tenantTokenQuotaV1Schema,
  tenantUsageSummaryV1Schema,
  calculateCostMicroUsd,
  formatMicroUsdToUsd,
  mockByokOpenAiFixture,
  mockByokAnthropicFixture,
  mockByokLocalFixture,
  mockByokSummaryListFixture,
  mockModelCompletionRequestFixture,
  mockModelCompletionResultFixture,
  mockTokenLedgerEntryFixture,
  mockTenantTokenQuotaFixture,
  mockTenantUsageSummaryFixture,
} from '../src';

describe('ModelGateway, BYOK & Token Cost Ledger Contracts', () => {
  describe('ModelGateway Completion Schemas', () => {
    it('validates a well-formed ModelCompletionRequestV1 fixture', () => {
      const parsed = modelCompletionRequestV1Schema.safeParse(mockModelCompletionRequestFixture);
      assert.ok(parsed.success, `Failed: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.provider, 'openai');
      assert.equal(parsed.data.messages.length, 2);
      assert.equal(parsed.data.tools?.length, 1);
    });

    it('accepts numeric tenantId and workspaceId in ModelCompletionRequestV1', () => {
      const req = {
        ...mockModelCompletionRequestFixture,
        tenantId: 42,
        workspaceId: 10,
        conversationId: 99,
      };
      const parsed = modelCompletionRequestV1Schema.safeParse(req);
      assert.ok(parsed.success);
      assert.equal(parsed.data.tenantId, 42);
    });

    it('rejects a completion request without messages', () => {
      const invalid = {
        ...mockModelCompletionRequestFixture,
        messages: [],
      };
      const parsed = modelCompletionRequestV1Schema.safeParse(invalid);
      assert.equal(parsed.success, false);
    });

    it('validates a ModelCompletionResultV1 fixture with tool calls and usage', () => {
      const parsed = modelCompletionResultV1Schema.safeParse(mockModelCompletionResultFixture);
      assert.ok(parsed.success);
      assert.equal(parsed.data.finishReason, 'tool_calls');
      assert.equal(parsed.data.toolCalls.length, 1);
      assert.equal(parsed.data.toolCalls[0].name, 'catalog.search');
      assert.equal(parsed.data.costMicroUsd, 1900);
    });

    it('validates test connection request and result schemas', () => {
      const testReq = {
        provider: 'openai' as const,
        apiKey: 'sk-test-key-12345',
        model: 'gpt-4o',
      };
      const parsedReq = testByokConnectionRequestV1Schema.safeParse(testReq);
      assert.ok(parsedReq.success);

      const testRes = {
        ok: true,
        provider: 'openai' as const,
        latencyMs: 142,
      };
      const parsedRes = testByokConnectionResultV1Schema.safeParse(testRes);
      assert.ok(parsedRes.success);
    });
  });

  describe('BYOK Credential Contracts', () => {
    it('validates OpenAI, Anthropic, and Local BYOK fixtures', () => {
      assert.ok(byokCredentialV1Schema.safeParse(mockByokOpenAiFixture).success);
      assert.ok(byokCredentialV1Schema.safeParse(mockByokAnthropicFixture).success);
      assert.ok(byokCredentialV1Schema.safeParse(mockByokLocalFixture).success);
    });

    it('rejects an invalid AES-256-GCM encryptedApiKey format', () => {
      const invalid = {
        ...mockByokOpenAiFixture,
        encryptedApiKey: 'not-a-valid-v1-aes-string',
      };
      const parsed = byokCredentialV1Schema.safeParse(invalid);
      assert.equal(parsed.success, false);
    });

    it('validates safe BYOK summaries list for UI GET endpoint', () => {
      for (const summary of mockByokSummaryListFixture) {
        const parsed = byokCredentialSummaryV1Schema.safeParse(summary);
        assert.ok(parsed.success);
      }
    });

    it('validates RegisterByokCredentialCommand for valid OpenAI key', () => {
      const cmd = {
        provider: 'openai' as const,
        apiKey: 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
        defaultModel: 'gpt-4o',
      };
      assert.ok(registerByokCredentialCommandV1Schema.safeParse(cmd).success);
    });

    it('rejects RegisterByokCredentialCommand for local_openai without baseUrl', () => {
      const cmd = {
        provider: 'local_openai' as const,
        baseUrl: null,
      };
      assert.equal(registerByokCredentialCommandV1Schema.safeParse(cmd).success, false);
    });

    it('accepts RegisterByokCredentialCommand for local_openai with valid baseUrl', () => {
      const cmd = {
        provider: 'local_openai' as const,
        baseUrl: 'http://ollama-internal.lan:11434',
        defaultModel: 'llama3:8b',
      };
      assert.ok(registerByokCredentialCommandV1Schema.safeParse(cmd).success);
    });
  });

  describe('Token Cost Ledger & Rate Cards', () => {
    it('validates TokenLedgerEntryV1 fixture', () => {
      const parsed = tokenLedgerEntryV1Schema.safeParse(mockTokenLedgerEntryFixture);
      assert.ok(parsed.success);
      assert.equal(parsed.data.costMicroUsd, 1900);
      assert.equal(parsed.data.status, 'success');
    });

    it('validates CreateTokenLedgerEntryCommandV1 schema', () => {
      const cmd = {
        tenantId: 42,
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        costMicroUsd: 6000,
      };
      assert.ok(createTokenLedgerEntryCommandV1Schema.safeParse(cmd).success);
    });

    it('calculates deterministic costs in micro-USD without floating point drift', () => {
      // gpt-4o: $2.50 / $10.00 per M
      const gpt4oCost = calculateCostMicroUsd('gpt-4o', 1000, 500);
      // 1000 * 2.5 + 500 * 10 = 2500 + 5000 = 7500 micro-USD ($0.0075)
      assert.equal(gpt4oCost, 7500);

      // claude-3-5-sonnet: $3.00 / $15.00 per M
      const claudeCost = calculateCostMicroUsd('claude-3-5-sonnet-20241022', 1000, 200);
      // 1000 * 3.0 + 200 * 15.0 = 3000 + 3000 = 6000 micro-USD ($0.0060)
      assert.equal(claudeCost, 6000);

      // local_openai: $0.00 / $0.00
      const localCost = calculateCostMicroUsd('local_openai', 5000, 2000);
      assert.equal(localCost, 0);

      // Fallback to default rate card
      const unknownCost = calculateCostMicroUsd('unknown-custom-model', 1000, 500);
      assert.equal(unknownCost, 7500);
    });

    it('formats micro-USD to USD decimal string correctly', () => {
      assert.equal(formatMicroUsdToUsd(12450000), '12.45');
      assert.equal(formatMicroUsdToUsd(7500), '0.01');
      assert.equal(formatMicroUsdToUsd(0), '0.00');
    });

    it('validates TenantTokenQuotaV1 and TenantUsageSummaryV1 fixtures', () => {
      assert.ok(tenantTokenQuotaV1Schema.safeParse(mockTenantTokenQuotaFixture).success);
      assert.ok(tenantUsageSummaryV1Schema.safeParse(mockTenantUsageSummaryFixture).success);
    });
  });
});
