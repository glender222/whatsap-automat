import { z } from 'zod';
import { CHANNEL_KINDS } from '../channels/types';

export const SEGMENT_RULE_OPERATORS = [
  'equals',
  'not_equals',
  'includes_any',
  'excludes',
  'gt',
  'lt',
  'opted_in',
  'exists',
] as const;

export type SegmentRuleOperator = (typeof SEGMENT_RULE_OPERATORS)[number];
export const segmentRuleOperatorSchema = z.enum(SEGMENT_RULE_OPERATORS);

export const segmentRuleV1Schema = z.object({
  field: z.string().min(1),
  operator: segmentRuleOperatorSchema,
  value: z.unknown().optional(),
});

export type SegmentRuleV1 = z.infer<typeof segmentRuleV1Schema>;

export const segmentCriteriaV1Schema = z.object({
  combinator: z.enum(['AND', 'OR']).default('AND'),
  rules: z.array(segmentRuleV1Schema).default([]),
});

export type SegmentCriteriaV1 = z.infer<typeof segmentCriteriaV1Schema>;

export const segmentTargetChannelSchema = z.enum([
  ...CHANNEL_KINDS,
  'any',
]);

export type SegmentTargetChannel = z.infer<typeof segmentTargetChannelSchema>;

export const segmentDefinitionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.union([z.number().int().positive(), z.string().min(1)]),
  workspaceId: z.union([z.number().int().positive(), z.string()]).nullable().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  targetChannel: segmentTargetChannelSchema.default('any'),
  criteria: segmentCriteriaV1Schema.default({ combinator: 'AND', rules: [] }),
  dynamic: z.boolean().default(true),
  staticContactIds: z.array(z.number().int().positive()).default([]),
  calculatedCount: z.number().int().nonnegative().default(0),
  lastCalculatedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type SegmentDefinitionV1 = z.infer<typeof segmentDefinitionV1Schema>;

export const createSegmentCommandV1Schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  targetChannel: segmentTargetChannelSchema.default('any'),
  criteria: segmentCriteriaV1Schema.default({ combinator: 'AND', rules: [] }),
  dynamic: z.boolean().default(true),
  staticContactIds: z.array(z.number().int().positive()).optional(),
});

export type CreateSegmentCommandV1 = z.infer<typeof createSegmentCommandV1Schema>;
