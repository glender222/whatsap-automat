import { atom } from 'jotai';
import type { AgentActivityCommand, AgentActivityTurn, AiAgent } from '../../factures/agentes/services/agentService';

export type AgentAction = 'suggest' | 'auto_reply' | 'handoff' | 'block';

export type PendingSuggestion = {
  chatId: string;
  agentId: number;
  reply: string;
  confidence: number;
  action: AgentAction;
  reason: string;
  usedKnowledgeIds: number[];
  receivedAt: number;
};

export type HandoffTicketSummary = {
  id: number;
  conversationId: number;
  chatId: string | null;
  customerName: string;
  reason: string;
  status: 'open' | 'taken' | 'closed' | 'cancelled';
  agentId: number | null;
  orderId: number | null;
  waitingSeconds: number;
  createdAt: string;
};

export type RuntimeLogEntry = {
  id: number;
  agentId: number | null;
  agentName: string | null;
  chatId: string | null;
  stage: string;
  level: string;
  status: string;
  summary: string;
  confidence: number | null;
  action: AgentAction | null;
  createdAt: string;
};

export type IaPauseStatus = {
  paused: boolean;
  pausedBy: number | null;
  pausedAt: string | null;
  resumeAt: string | null;
  reason: string | null;
  expired: boolean;
};

export type AgentState = {
  currentAgent: AiAgent | null;
  pendingSuggestion: PendingSuggestion | null;
  lastAction: AgentAction | null;
  lastConfidence: number | null;
  lastUpdatedAt: number | null;
  iaPauseByChat: Record<string, IaPauseStatus>;
  handoffTickets: HandoffTicketSummary[];
  handoffCount: number;
  runtimeLogFeed: RuntimeLogEntry[];
  autoReplyFeed: Array<{ chatId: string; reply: string; confidence: number; receivedAt: number }>;
  blockedFeed: Array<{ chatId: string; reason: string; topic: string | null; receivedAt: number }>;
  orderFeed: Array<{ chatId: string; orderId: number; status: string; agentId?: number | null; receivedAt: number }>;
  voucherFeed: Array<{ chatId?: string | null; voucherId: number; receivedAt: number }>;
  paymentFeed: Array<{ voucherId?: number; status?: string; chatId?: string | null; event: string; receivedAt: number }>;
  typingByChat: Record<string, { agentId: number; receivedAt: number }>;
  activityByChat: Record<string, AgentActivityTurn[]>;
  aiSessionByChat: Record<string, { sessionId: number; status: 'active' | 'paused' | 'handoff' | 'closed'; agentId: number | null; domainKey: string; receivedAt: number }>;
  companyModeChangedAt: number | null;
};

export const initialAgentState: AgentState = {
  currentAgent: null,
  pendingSuggestion: null,
  lastAction: null,
  lastConfidence: null,
  lastUpdatedAt: null,
  iaPauseByChat: {},
  handoffTickets: [],
  handoffCount: 0,
  runtimeLogFeed: [],
  autoReplyFeed: [],
  blockedFeed: [],
  orderFeed: [],
  voucherFeed: [],
  paymentFeed: [],
  typingByChat: {},
  activityByChat: {},
  aiSessionByChat: {},
  companyModeChangedAt: null,
};

export const setAiSessionStatusAtom = atom(
  null,
  (get, set, payload: { chatId: string; sessionId: number; status: 'active' | 'paused' | 'handoff' | 'closed'; agentId: number | null; domainKey: string }) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, {
      ...current,
      aiSessionByChat: {
        ...current.aiSessionByChat,
        [payload.chatId]: { ...payload, receivedAt: Date.now() },
      },
    });
  }
);

export const setChatActivityAtom = atom(
  null,
  (get, set, payload: { chatId: string; turns: AgentActivityTurn[] }) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, {
      ...current,
      activityByChat: { ...current.activityByChat, [payload.chatId]: payload.turns },
    });
  }
);

export const upsertActivityTurnAtom = atom(
  null,
  (get, set, payload: {
    chatId: string;
    sessionId: number;
    turnId: number;
    agentId: number | null;
    status: AgentActivityTurn['status'];
    finalAction?: AgentActivityTurn['finalAction'];
    finalReplyPreview?: string;
    commandCount?: number;
    inboundProviderMessageId?: string | null;
  }) => {
    const current = get(agentStateAtom);
    const existing = current.activityByChat[payload.chatId] || [];
    const index = existing.findIndex((turn) => turn.id === payload.turnId);
    const nextTurn: AgentActivityTurn = index >= 0
      ? {
          ...existing[index],
          status: payload.status,
          finalAction: payload.finalAction || existing[index].finalAction,
          finalReplyPreview: payload.finalReplyPreview ?? existing[index].finalReplyPreview,
          commandCount: payload.commandCount ?? existing[index].commandCount,
          inboundProviderMessageId: payload.inboundProviderMessageId ?? existing[index].inboundProviderMessageId,
          completedAt: payload.status === 'running' ? existing[index].completedAt : new Date().toISOString(),
        }
      : {
          id: payload.turnId,
          sessionId: payload.sessionId,
          agentId: payload.agentId,
          agentName: 'Agente IA',
          inboundProviderMessageId: payload.inboundProviderMessageId || null,
          status: payload.status,
          finalAction: payload.finalAction || 'none',
          finalReplyPreview: payload.finalReplyPreview || '',
          commandCount: payload.commandCount || 0,
          startedAt: new Date().toISOString(),
          completedAt: payload.status === 'running' ? null : new Date().toISOString(),
          commands: [],
        };
    const next = index >= 0
      ? existing.map((turn, i) => (i === index ? nextTurn : turn))
      : [nextTurn, ...existing].slice(0, 50);
    set(agentStateAtom, {
      ...current,
      activityByChat: { ...current.activityByChat, [payload.chatId]: next },
    });
  }
);

export const pushActivityEventAtom = atom(
  null,
  (get, set, payload: { chatId: string; turnId: number; event: AgentActivityCommand }) => {
    const current = get(agentStateAtom);
    const existing = current.activityByChat[payload.chatId] || [];
    const next = existing.map((turn) => {
      if (turn.id !== payload.turnId) return turn;
      const commands = [payload.event, ...turn.commands.filter((command) => command.id !== payload.event.id)]
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return { ...turn, commands, commandCount: Math.max(turn.commandCount, commands.filter((c) => c.toolName).length) };
    });
    set(agentStateAtom, {
      ...current,
      activityByChat: { ...current.activityByChat, [payload.chatId]: next },
    });
  }
);

export const agentStateAtom = atom<AgentState>(initialAgentState);

export const setPendingSuggestionAtom = atom(
  null,
  (get, set, suggestion: PendingSuggestion | null) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, {
      ...current,
      pendingSuggestion: suggestion,
      lastAction: suggestion?.action ?? current.lastAction,
      lastConfidence: suggestion?.confidence ?? current.lastConfidence,
      lastUpdatedAt: Date.now(),
    });
  }
);

export const setIaPauseStatusAtom = atom(
  null,
  (get, set, payload: { chatId: string; status: IaPauseStatus }) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, {
      ...current,
      iaPauseByChat: { ...current.iaPauseByChat, [payload.chatId]: payload.status },
    });
  }
);

export const setHandoffTicketsAtom = atom(
  null,
  (get, set, tickets: HandoffTicketSummary[]) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, {
      ...current,
      handoffTickets: tickets,
      handoffCount: tickets.filter((t) => t.status === 'open').length,
    });
  }
);

export const pushAutoReplyAtom = atom(
  null,
  (get, set, payload: { chatId: string; reply: string; confidence: number }) => {
    const current = get(agentStateAtom);
    const entry = { ...payload, receivedAt: Date.now() };
    const nextFeed = [entry, ...current.autoReplyFeed].slice(0, 20);
    set(agentStateAtom, { ...current, autoReplyFeed: nextFeed });
  }
);

export const pushBlockedAtom = atom(
  null,
  (get, set, payload: { chatId: string; reason: string; topic: string | null }) => {
    const current = get(agentStateAtom);
    const entry = { ...payload, receivedAt: Date.now() };
    const nextFeed = [entry, ...current.blockedFeed].slice(0, 20);
    set(agentStateAtom, { ...current, blockedFeed: nextFeed });
  }
);

export const pushOrderDetectedAtom = atom(
  null,
  (get, set, payload: { chatId: string; orderId: number; status: string; agentId?: number | null }) => {
    const current = get(agentStateAtom);
    const entry = { ...payload, receivedAt: Date.now() };
    set(agentStateAtom, { ...current, orderFeed: [entry, ...current.orderFeed].slice(0, 30), lastUpdatedAt: entry.receivedAt });
  }
);

export const pushVoucherAtom = atom(
  null,
  (get, set, payload: { chatId?: string | null; voucherId: number }) => {
    const current = get(agentStateAtom);
    const entry = { ...payload, receivedAt: Date.now() };
    set(agentStateAtom, { ...current, voucherFeed: [entry, ...current.voucherFeed].slice(0, 30), lastUpdatedAt: entry.receivedAt });
  }
);

export const pushPaymentEventAtom = atom(
  null,
  (get, set, payload: { voucherId?: number; status?: string; chatId?: string | null; event: string }) => {
    const current = get(agentStateAtom);
    const entry = { ...payload, receivedAt: Date.now() };
    set(agentStateAtom, { ...current, paymentFeed: [entry, ...current.paymentFeed].slice(0, 30), lastUpdatedAt: entry.receivedAt });
  }
);

export const setAgentTypingAtom = atom(
  null,
  (get, set, payload: { chatId: string; agentId: number }) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, {
      ...current,
      typingByChat: { ...current.typingByChat, [payload.chatId]: { agentId: payload.agentId, receivedAt: Date.now() } },
    });
  }
);

export const setCompanyModeChangedAtom = atom(
  null,
  (get, set) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, { ...current, companyModeChangedAt: Date.now() });
  }
);

export const pushRuntimeLogAtom = atom(
  null,
  (get, set, entry: RuntimeLogEntry) => {
    const current = get(agentStateAtom);
    const nextFeed = [entry, ...current.runtimeLogFeed].slice(0, 50);
    set(agentStateAtom, { ...current, runtimeLogFeed: nextFeed });
  }
);

export const setCurrentAgentAtom = atom(
  null,
  (get, set, agent: AiAgent | null) => {
    const current = get(agentStateAtom);
    set(agentStateAtom, { ...current, currentAgent: agent });
  }
);
