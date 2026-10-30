import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { AgentHandoffService } from '../modules/ai/application/AgentHandoffService';

test('handoff activo se reutiliza y no se crea dos veces', async () => {
  let activeTicket: any = null;
  const create = mock.fn(async (input: any) => {
    activeTicket = {
      id: 77,
      companyId: input.companyId,
      conversationId: input.conversationId,
      agentId: input.agentId ?? null,
      orderId: input.orderId ?? null,
      reason: input.reason,
      priority: input.priority,
      status: 'open',
      takenBy: null,
      takenAt: null,
      closedAt: null,
      closedBy: null,
      outcome: null,
      notes: null,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return activeTicket;
  });
  const assignHandoffTag = mock.fn(async () => undefined);
  const repository = {
    findActiveByConversation: mock.fn(async () => activeTicket),
    create,
    assignHandoffTag,
  };
  const service = new AgentHandoffService(repository as any);
  const input = {
    companyId: 1,
    conversationId: 10,
    chatId: '51999999999',
    agentId: 5,
    reason: 'customer_asks_human',
  };

  const first = await service.createTicket(input);
  const second = await service.createTicket(input);

  assert.equal(first.id, 77);
  assert.equal(second.id, 77);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(assignHandoffTag.mock.callCount(), 1);
});
