import { z } from 'zod';
import { ChannelKind, CHANNEL_KINDS } from './types';
import { ProblemDetailsV1, createProblemDetails } from '../errors/problemDetails';
import { StandardErrorCode } from '../errors/codes';

/**
 * Dimension 1: Technical Feature Support
 */
export interface TechnicalFeatures {
  readonly text: boolean;
  readonly image: boolean;
  readonly audio: boolean;
  readonly video: boolean;
  readonly document: boolean;
  readonly template: boolean;
  readonly interactive: boolean;
  readonly reactions: boolean;
  readonly typing: boolean;
  readonly readReceipt: boolean;
}

/**
 * Dimension 2: Granted API Scopes
 */
export type ChannelScopes = readonly string[];

/**
 * Dimension 3: Channel Policies & Session Windows
 */
export interface ChannelPolicies {
  readonly sessionWindowHours?: number; // e.g. 24 for Meta WhatsApp / Instagram
  readonly requiresHsmTemplateOutsideWindow: boolean;
  readonly rateLimitPerMinute?: number;
  readonly requiresOptIn: boolean;
}

/**
 * Dimension 4: Real-time Connection Health
 */
export interface ConnectionHealth {
  readonly status: 'healthy' | 'degraded' | 'down' | 'needs_reauthorization';
  readonly lastCheckedAt: string;
  readonly latencyMs?: number;
  readonly errorMessage?: string;
}

/**
 * Dimension 5: Budget & Cost Tier
 */
export interface ChannelBudget {
  readonly tier: 'free' | 'standard' | 'enterprise';
  readonly costPerMessageCents?: number;
  readonly monthlyBudgetLimitCents?: number;
  readonly currentMonthSpendCents?: number;
}

/**
 * Dimension 6: Regional Restrictions
 */
export interface RegionalConstraints {
  readonly blacklistedCountries: readonly string[]; // ISO 3166-1 alpha-2 codes (e.g. 'KP', 'SY')
  readonly restrictedFeaturesByCountry?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Universal 6-Dimensional Channel Capability Matrix
 * WAA-006, PROD-004, PROD-012, ADR-005
 */
export interface ChannelCapabilityMatrix {
  readonly connectionId: string;
  readonly tenantId: string;
  readonly channel: ChannelKind;
  readonly features: TechnicalFeatures;
  readonly scopes: ChannelScopes;
  readonly policies: ChannelPolicies;
  readonly health: ConnectionHealth;
  readonly budget: ChannelBudget;
  readonly regional: RegionalConstraints;
  readonly updatedAt: string;
}

/**
 * Zod schema for ChannelCapabilityMatrix
 */
export const technicalFeaturesSchema = z.object({
  text: z.boolean(),
  image: z.boolean(),
  audio: z.boolean(),
  video: z.boolean(),
  document: z.boolean(),
  template: z.boolean(),
  interactive: z.boolean(),
  reactions: z.boolean(),
  typing: z.boolean(),
  readReceipt: z.boolean(),
});

export const channelPoliciesSchema = z.object({
  sessionWindowHours: z.number().positive().optional(),
  requiresHsmTemplateOutsideWindow: z.boolean(),
  rateLimitPerMinute: z.number().int().positive().optional(),
  requiresOptIn: z.boolean(),
});

export const connectionHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'down', 'needs_reauthorization']),
  lastCheckedAt: z.string(),
  latencyMs: z.number().nonnegative().optional(),
  errorMessage: z.string().optional(),
});

export const channelBudgetSchema = z.object({
  tier: z.enum(['free', 'standard', 'enterprise']),
  costPerMessageCents: z.number().nonnegative().optional(),
  monthlyBudgetLimitCents: z.number().nonnegative().optional(),
  currentMonthSpendCents: z.number().nonnegative().optional(),
});

export const regionalConstraintsSchema = z.object({
  blacklistedCountries: z.array(z.string().length(2)),
  restrictedFeaturesByCountry: z.record(z.array(z.string())).optional(),
});

export const channelCapabilityMatrixSchema = z.object({
  connectionId: z.string().min(1),
  tenantId: z.string().min(1),
  channel: z.enum(CHANNEL_KINDS),
  features: technicalFeaturesSchema,
  scopes: z.array(z.string()),
  policies: channelPoliciesSchema,
  health: connectionHealthSchema,
  budget: channelBudgetSchema,
  regional: regionalConstraintsSchema,
  updatedAt: z.string(),
});

/**
 * Publish Action Intent evaluated by the Publish Gate
 */
export interface PublishIntent {
  readonly messageKind: keyof TechnicalFeatures;
  readonly isTemplate?: boolean;
  readonly recipientCountry?: string; // 2-letter ISO country code
  readonly lastCustomerInteractionAt?: string | Date;
  readonly correlationId: string;
}

export type PublishGateResult =
  | { readonly permitted: true }
  | {
      readonly permitted: false;
      readonly reasonCode:
        | 'CH_WA_WINDOW_CLOSED'
        | 'CAPABILITY_UNSUPPORTED'
        | 'CHANNEL_UNHEALTHY'
        | 'REGION_RESTRICTED'
        | 'BUDGET_EXCEEDED';
      readonly problemDetails: ProblemDetailsV1;
    };

/**
 * Evaluates whether an outbound message intent is permitted according to
 * the 6-dimensional ChannelCapabilityMatrix (PROD-004 / ADR-005).
 */
export function evaluatePublishGate(
  matrix: ChannelCapabilityMatrix,
  intent: PublishIntent
): PublishGateResult {
  const correlationId = intent.correlationId || 'none';
  const instance = `/connections/${matrix.connectionId}/publish-gate`;

  // 1. Connection Health Check
  if (matrix.health.status === 'down' || matrix.health.status === 'needs_reauthorization') {
    return {
      permitted: false,
      reasonCode: 'CHANNEL_UNHEALTHY',
      problemDetails: createProblemDetails({
        code: StandardErrorCode.POLICY_DENIED,
        title: 'Channel Connection Unhealthy',
        detail: `The connection is in status '${matrix.health.status}' and cannot deliver messages: ${matrix.health.errorMessage || 'No error details provided'}`,
        instance,
        correlationId,
        metadata: {
          connectionId: matrix.connectionId,
          healthStatus: matrix.health.status,
        },
      }),
    };
  }

  // 2. Technical Feature Support
  if (!matrix.features[intent.messageKind]) {
    return {
      permitted: false,
      reasonCode: 'CAPABILITY_UNSUPPORTED',
      problemDetails: createProblemDetails({
        code: StandardErrorCode.POLICY_DENIED,
        title: 'Channel Capability Unsupported',
        detail: `Channel '${matrix.channel}' does not support '${intent.messageKind}' payloads.`,
        instance,
        correlationId,
        metadata: {
          channel: matrix.channel,
          requestedFeature: intent.messageKind,
        },
      }),
    };
  }

  // 3. Regional Restrictions
  if (intent.recipientCountry) {
    const countryUpper = intent.recipientCountry.toUpperCase();
    if (matrix.regional.blacklistedCountries.map((c) => c.toUpperCase()).includes(countryUpper)) {
      return {
        permitted: false,
        reasonCode: 'REGION_RESTRICTED',
        problemDetails: createProblemDetails({
          code: StandardErrorCode.POLICY_DENIED,
          title: 'Recipient Region Restricted',
          detail: `Outbound delivery to country '${countryUpper}' is prohibited by regional compliance policy.`,
          instance,
          correlationId,
          metadata: {
            country: countryUpper,
          },
        }),
      };
    }
  }

  // 4. Budget Constraints
  if (matrix.budget.monthlyBudgetLimitCents !== undefined && matrix.budget.currentMonthSpendCents !== undefined) {
    const estimatedCost = matrix.budget.costPerMessageCents || 0;
    if (matrix.budget.currentMonthSpendCents + estimatedCost > matrix.budget.monthlyBudgetLimitCents) {
      return {
        permitted: false,
        reasonCode: 'BUDGET_EXCEEDED',
        problemDetails: createProblemDetails({
          code: StandardErrorCode.RATE_LIMITED,
          title: 'Monthly Channel Budget Exceeded',
          detail: `Monthly budget limit of ${matrix.budget.monthlyBudgetLimitCents} cents reached. Current spend: ${matrix.budget.currentMonthSpendCents} cents.`,
          instance,
          correlationId,
          metadata: {
            monthlyLimit: matrix.budget.monthlyBudgetLimitCents,
            currentSpend: matrix.budget.currentMonthSpendCents,
          },
        }),
      };
    }
  }

  // 5. Session Window Check (e.g. WhatsApp 24-hour customer service window)
  if (matrix.policies.requiresHsmTemplateOutsideWindow && matrix.policies.sessionWindowHours) {
    if (!intent.isTemplate) {
      if (!intent.lastCustomerInteractionAt) {
        // No interaction recorded at all -> outside window
        return {
          permitted: false,
          reasonCode: 'CH_WA_WINDOW_CLOSED',
          problemDetails: createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            title: 'Customer Service Window Closed',
            detail: `The ${matrix.policies.sessionWindowHours}h customer service window has expired. Only approved HSM templates are permitted.`,
            instance,
            correlationId,
            metadata: {
              windowHours: matrix.policies.sessionWindowHours,
            },
          }),
        };
      }

      const lastInteraction = new Date(intent.lastCustomerInteractionAt).getTime();

      // Fail-closed defense: If date string cannot be parsed into a finite timestamp, reject immediately
      if (!Number.isFinite(lastInteraction)) {
        return {
          permitted: false,
          reasonCode: 'CH_WA_WINDOW_CLOSED',
          problemDetails: createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            title: 'Customer Service Window Closed',
            detail: `The ${matrix.policies.sessionWindowHours}h customer service window cannot be verified because lastCustomerInteractionAt is invalid ('${String(intent.lastCustomerInteractionAt)}'). Only approved HSM templates are permitted.`,
            instance,
            correlationId,
            metadata: {
              windowHours: matrix.policies.sessionWindowHours,
              lastCustomerInteractionAt: String(intent.lastCustomerInteractionAt),
            },
          }),
        };
      }

      const elapsedHours = (Date.now() - lastInteraction) / (1000 * 60 * 60);

      if (elapsedHours > matrix.policies.sessionWindowHours) {
        return {
          permitted: false,
          reasonCode: 'CH_WA_WINDOW_CLOSED',
          problemDetails: createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            title: 'Customer Service Window Closed',
            detail: `The ${matrix.policies.sessionWindowHours}h customer service window has expired (${elapsedHours.toFixed(1)}h elapsed). Only approved HSM templates are permitted.`,
            instance,
            correlationId,
            metadata: {
              windowHours: matrix.policies.sessionWindowHours,
              elapsedHours,
            },
          }),
        };
      }
    }
  }

  return { permitted: true };
}
