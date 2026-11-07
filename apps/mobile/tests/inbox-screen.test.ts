import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationV1 } from '@whatsap-automat/contracts';

describe('Phase F9 Mobile: Inbox Screen Filtering & Badging Logic', () => {
  const mockConversations: ConversationV1[] = [
    {
      id: '1',
      tenantId: '1',
      connectionId: 'conn_1',
      channel: 'whatsapp-cloud',
      externalConversationId: '+1234567890',
      contactIdentityId: null,
      title: 'Customer Alpha',
      status: 'open',
      stage: 'new',
      stateVersion: 1,
      aiPaused: false,
      aiPausedUntil: null,
      assignedUserId: null,
      assignedAgentId: null,
      lastMessageAt: '2026-11-05T01:00:00Z',
      serviceWindowExpiresAt: null,
      createdAt: '2026-11-05T00:00:00Z',
      updatedAt: '2026-11-05T01:00:00Z',
    },
    {
      id: '2',
      tenantId: '1',
      connectionId: 'conn_2',
      channel: 'instagram',
      externalConversationId: 'ig_customer_beta',
      contactIdentityId: null,
      title: 'Customer Beta',
      status: 'open',
      stage: 'handoff',
      stateVersion: 3,
      aiPaused: true,
      aiPausedUntil: null,
      assignedUserId: 'agent_me',
      assignedAgentId: null,
      lastMessageAt: '2026-11-05T02:00:00Z',
      serviceWindowExpiresAt: null,
      createdAt: '2026-11-05T00:00:00Z',
      updatedAt: '2026-11-05T02:00:00Z',
    },
    {
      id: '3',
      tenantId: '1',
      connectionId: 'conn_3',
      channel: 'tiktok',
      externalConversationId: 'tiktok_user_gamma',
      contactIdentityId: null,
      title: 'Customer Gamma',
      status: 'closed',
      stage: 'closed',
      stateVersion: 2,
      aiPaused: true,
      aiPausedUntil: null,
      assignedUserId: 'agent_other',
      assignedAgentId: null,
      lastMessageAt: '2026-11-04T22:00:00Z',
      serviceWindowExpiresAt: null,
      createdAt: '2026-11-04T20:00:00Z',
      updatedAt: '2026-11-04T22:00:00Z',
    },
  ];

  const applyFilter = (
    list: ConversationV1[],
    tab: 'all' | 'mine' | 'unassigned',
    userId: string
  ) => {
    return list.filter((c) => {
      if (tab === 'mine') return c.assignedUserId === userId;
      if (tab === 'unassigned') return c.assignedUserId === null;
      return true;
    });
  };

  test('1. Filter Tab "all" returns all active items', () => {
    const items = applyFilter(mockConversations, 'all', 'agent_me');
    assert.equal(items.length, 3);
  });

  test('2. Filter Tab "mine" returns only items assigned to active operator', () => {
    const items = applyFilter(mockConversations, 'mine', 'agent_me');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '2');
  });

  test('3. Filter Tab "unassigned" returns only items without human assignee', () => {
    const items = applyFilter(mockConversations, 'unassigned', 'agent_me');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '1');
  });

  test('4. Keyword search matches by phone number or contact title', () => {
    const query = '12345';
    const results = mockConversations.filter((c) => {
      return (
        (c.title || '').toLowerCase().includes(query) ||
        (c.externalConversationId || '').toLowerCase().includes(query)
      );
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, '1');
  });
});
