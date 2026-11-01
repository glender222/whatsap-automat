import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelCapabilityMatrix,
  channelCapabilityMatrixSchema,
  evaluatePublishGate,
  PublishIntent,
} from '../src';

describe('CAP-01: Universal 6-Dimensional Channel Capability Matrix & Publish Gate', () => {
  const baseWhatsAppMatrix: ChannelCapabilityMatrix = {
    connectionId: 'conn-wa-prod-01',
    tenantId: '10',
    channel: 'whatsapp-cloud',
    features: {
      text: true,
      image: true,
      audio: true,
      video: true,
      document: true,
      template: true,
      interactive: true,
      reactions: true,
      typing: true,
      readReceipt: true,
    },
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    policies: {
      sessionWindowHours: 24,
      requiresHsmTemplateOutsideWindow: true,
      rateLimitPerMinute: 600,
      requiresOptIn: true,
    },
    health: {
      status: 'healthy',
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 120,
    },
    budget: {
      tier: 'standard',
      costPerMessageCents: 5,
      monthlyBudgetLimitCents: 100000,
      currentMonthSpendCents: 45000,
    },
    regional: {
      blacklistedCountries: ['KP', 'SY', 'IR'],
      restrictedFeaturesByCountry: {
        BR: ['audio'],
      },
    },
    updatedAt: new Date().toISOString(),
  };

  it('validates a complete 6-dimensional Capability Matrix against Zod schema', () => {
    const parsed = channelCapabilityMatrixSchema.safeParse(baseWhatsAppMatrix);
    assert.ok(parsed.success, `Matrix validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('permits valid text message inside 24h customer window', () => {
    const recentInteraction = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const intent: PublishIntent = {
      messageKind: 'text',
      isTemplate: false,
      recipientCountry: 'AR',
      lastCustomerInteractionAt: recentInteraction,
      correlationId: 'corr-valid-window-01',
    };

    const result = evaluatePublishGate(baseWhatsAppMatrix, intent);
    assert.equal(result.permitted, true);
  });

  it('blocks free-form text outside 24h window with CH_WA_WINDOW_CLOSED problem details', () => {
    const expiredInteraction = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(); // 26 hours ago
    const intent: PublishIntent = {
      messageKind: 'text',
      isTemplate: false,
      recipientCountry: 'AR',
      lastCustomerInteractionAt: expiredInteraction,
      correlationId: 'corr-expired-window-01',
    };

    const result = evaluatePublishGate(baseWhatsAppMatrix, intent);
    assert.equal(result.permitted, false);
    if (!result.permitted) {
      assert.equal(result.reasonCode, 'CH_WA_WINDOW_CLOSED');
      assert.equal(result.problemDetails.status, 403);
      assert.ok(result.problemDetails.detail.includes('customer service window has expired'));
    }
  });

  it('permits approved template even outside 24h window', () => {
    const expiredInteraction = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
    const intent: PublishIntent = {
      messageKind: 'template',
      isTemplate: true,
      recipientCountry: 'AR',
      lastCustomerInteractionAt: expiredInteraction,
      correlationId: 'corr-template-window-01',
    };

    const result = evaluatePublishGate(baseWhatsAppMatrix, intent);
    assert.equal(result.permitted, true);
  });

  it('blocks unsupported features with CAPABILITY_UNSUPPORTED problem details', () => {
    const smsLimitedMatrix: ChannelCapabilityMatrix = {
      ...baseWhatsAppMatrix,
      channel: 'telegram',
      features: {
        ...baseWhatsAppMatrix.features,
        interactive: false, // interactive unsupported
      },
    };

    const intent: PublishIntent = {
      messageKind: 'interactive',
      isTemplate: false,
      correlationId: 'corr-unsupported-feat',
    };

    const result = evaluatePublishGate(smsLimitedMatrix, intent);
    assert.equal(result.permitted, false);
    if (!result.permitted) {
      assert.equal(result.reasonCode, 'CAPABILITY_UNSUPPORTED');
      assert.equal(result.problemDetails.status, 403);
      assert.ok(result.problemDetails.detail.includes("does not support 'interactive'"));
    }
  });

  it('blocks actions when connection is unhealthy or down', () => {
    const downMatrix: ChannelCapabilityMatrix = {
      ...baseWhatsAppMatrix,
      health: {
        status: 'down',
        lastCheckedAt: new Date().toISOString(),
        errorMessage: 'Meta Cloud API access token revoked by provider',
      },
    };

    const intent: PublishIntent = {
      messageKind: 'text',
      correlationId: 'corr-down-conn',
    };

    const result = evaluatePublishGate(downMatrix, intent);
    assert.equal(result.permitted, false);
    if (!result.permitted) {
      assert.equal(result.reasonCode, 'CHANNEL_UNHEALTHY');
      assert.equal(result.problemDetails.status, 403);
      assert.ok(result.problemDetails.detail.includes('revoked'));
    }
  });

  it('blocks actions to regionally blacklisted countries', () => {
    const intent: PublishIntent = {
      messageKind: 'text',
      recipientCountry: 'KP', // North Korea blacklisted
      correlationId: 'corr-blacklisted-country',
    };

    const result = evaluatePublishGate(baseWhatsAppMatrix, intent);
    assert.equal(result.permitted, false);
    if (!result.permitted) {
      assert.equal(result.reasonCode, 'REGION_RESTRICTED');
      assert.equal(result.problemDetails.status, 403);
      assert.ok(result.problemDetails.detail.includes('KP'));
    }
  });

  it('blocks actions when monthly budget limit is exceeded', () => {
    const cappedMatrix: ChannelCapabilityMatrix = {
      ...baseWhatsAppMatrix,
      budget: {
        tier: 'standard',
        costPerMessageCents: 10,
        monthlyBudgetLimitCents: 5000,
        currentMonthSpendCents: 5000, // Budget exhausted
      },
    };

    const intent: PublishIntent = {
      messageKind: 'text',
      correlationId: 'corr-budget-exhausted',
    };

    const result = evaluatePublishGate(cappedMatrix, intent);
    assert.equal(result.permitted, false);
    if (!result.permitted) {
      assert.equal(result.reasonCode, 'BUDGET_EXCEEDED');
      assert.equal(result.problemDetails.status, 429);
      assert.ok(result.problemDetails.detail.includes('Monthly budget limit'));
    }
  });
});
