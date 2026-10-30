import type { AutomatorMode } from '../domain/agent.types';
import type { AgentAction, DetectedOrder } from '../domain/runtime.types';
import type { AiAgent } from '../domain/agent.types';

export type ProductAvailability = {
  available: boolean;
  requiresApproval: boolean;
  availabilityStatus: string;
};

export type AgentDecisionInput = {
  rawAction: unknown;
  confidence: number;
  threshold: number;
  agentMode: AiAgent['mode'];
  companyMode: AutomatorMode;
  agent: AiAgent;
  detectedOrder?: DetectedOrder | null;
  productAvailability: ProductAvailability[];
  blockedTopicHit?: string | null;
};

export type AgentDecision = {
  action: AgentAction;
  reason: string;
  canAutoConfirmOrder: boolean;
  canCreateVoucher: boolean;
  canGeneratePaymentLink: boolean;
};

const VALID_ACTIONS: AgentAction[] = ['suggest', 'auto_reply', 'handoff', 'block'];

export class AgentDecisionEngine {
  resolve(input: AgentDecisionInput): AgentDecision {
    const canAutoConfirm = this.canAutoConfirmOrder(input);
    const canCreateVoucher = this.canCreateVoucher(input);
    const canGenerateLink = this.canGeneratePaymentLink(input);

    if (input.blockedTopicHit) {
      return {
        action: 'block',
        reason: `Tema bloqueado detectado: ${input.blockedTopicHit}`,
        canAutoConfirmOrder: false,
        canCreateVoucher: false,
        canGeneratePaymentLink: false,
      };
    }

    const normalized: AgentAction = VALID_ACTIONS.includes(String(input.rawAction) as AgentAction)
      ? (String(input.rawAction) as AgentAction)
      : 'suggest';

    if (normalized === 'block' || normalized === 'handoff') {
      return {
        action: normalized,
        reason: '',
        canAutoConfirmOrder: canAutoConfirm,
        canCreateVoucher,
        canGeneratePaymentLink: canGenerateLink,
      };
    }

    if (input.confidence < input.threshold) {
      return {
        action: 'suggest',
        reason: 'Confianza por debajo del umbral',
        canAutoConfirmOrder: false,
        canCreateVoucher,
        canGeneratePaymentLink: false,
      };
    }

    const autoReplyAllowed = input.companyMode === 'automator';
    if (input.agentMode === 'auto' && autoReplyAllowed) {
      return {
        action: 'auto_reply',
        reason: '',
        canAutoConfirmOrder: canAutoConfirm,
        canCreateVoucher,
        canGeneratePaymentLink: canGenerateLink,
      };
    }

    return {
      action: 'suggest',
      reason: 'Modo agente o company no permite auto-reply',
      canAutoConfirmOrder: false,
      canCreateVoucher,
      canGeneratePaymentLink: false,
    };
  }

  canAutoConfirmOrder(input: AgentDecisionInput): boolean {
    return false;
  }

  canCreateVoucher(input: AgentDecisionInput): boolean {
    return false;
  }

  canGeneratePaymentLink(input: AgentDecisionInput): boolean {
    return false;
  }

  detectBlockedTopic(reply: string, blockedTopics: string[]): string | null {
    if (!Array.isArray(blockedTopics) || blockedTopics.length === 0) return null;
    const text = String(reply || '').toLowerCase();
    for (const topic of blockedTopics) {
      const needle = String(topic || '').trim().toLowerCase();
      if (needle && text.includes(needle)) return topic;
    }
    return null;
  }
}
