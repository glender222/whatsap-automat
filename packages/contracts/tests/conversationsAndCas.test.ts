import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationV1Schema,
  conversationMessageV1Schema,
  takeoverCommandV1Schema,
  pauseAiCommandV1Schema,
  resumeAiCommandV1Schema,
  serverEventV1Schema,
  canonicalConversationFixture,
  canonicalMessageFixture,
  takeoverCommandFixture,
  pauseAiCommandFixture,
  resumeAiCommandFixture,
  serverRealtimeEventsFixtures,
  createTenantRoom,
  createConversationRoom,
  createUserRoom,
} from '../src';

describe('Conversations, CAS Commands & Realtime Contracts', () => {
  it('validates canonical conversation fixture', () => {
    const parsed = conversationV1Schema.safeParse(canonicalConversationFixture);
    assert.ok(parsed.success, `Conversation validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.stateVersion, 3);
    assert.equal(parsed.data.stage, 'catalog');
  });

  it('validates canonical message fixture', () => {
    const parsed = conversationMessageV1Schema.safeParse(canonicalMessageFixture);
    assert.ok(parsed.success, `Message validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.direction, 'inbound');
    assert.equal(parsed.data.deliveryState, 'delivered');
  });

  it('validates TakeoverCommandV1 (CAS handoff)', () => {
    const parsed = takeoverCommandV1Schema.safeParse(takeoverCommandFixture);
    assert.ok(parsed.success, `Takeover validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.schemaVersion, 1);
    assert.equal(parsed.data.expectedVersion, 3);
    assert.ok(parsed.data.userId.length > 0);
  });

  it('validates PauseAiCommandV1 and ResumeAiCommandV1 (CAS pause/resume)', () => {
    const pauseParsed = pauseAiCommandV1Schema.safeParse(pauseAiCommandFixture);
    assert.ok(pauseParsed.success, `Pause validation failed: ${JSON.stringify(pauseParsed.error?.issues)}`);
    assert.equal(pauseParsed.data.expectedVersion, 3);
    assert.equal(pauseParsed.data.durationSeconds, 7200);

    const resumeParsed = resumeAiCommandV1Schema.safeParse(resumeAiCommandFixture);
    assert.ok(resumeParsed.success, `Resume validation failed: ${JSON.stringify(resumeParsed.error?.issues)}`);
    assert.equal(resumeParsed.data.expectedVersion, 4);
  });

  it('validates server realtime events discriminated union', () => {
    for (const evt of serverRealtimeEventsFixtures) {
      const parsed = serverEventV1Schema.safeParse(evt);
      assert.ok(parsed.success, `Server event validation failed for type ${evt.type}: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.type, evt.type);
    }
  });

  it('generates server-authorized room names according to convention', () => {
    const tenantRoom = createTenantRoom('tenant_alpha');
    assert.equal(tenantRoom, 'tenant:tenant_alpha');

    const convRoom = createConversationRoom('tenant_alpha', 'conv_123');
    assert.equal(convRoom, 'conversation:tenant_alpha:conv_123');

    const userRoom = createUserRoom('tenant_alpha', 'user_456');
    assert.equal(userRoom, 'user:tenant_alpha:user_456');
  });

  it('rejects invalid CAS commands with negative expectedVersion', () => {
    const invalid = {
      ...takeoverCommandFixture,
      expectedVersion: -1,
    };
    const parsed = takeoverCommandV1Schema.safeParse(invalid);
    assert.equal(parsed.success, false);
  });
});
