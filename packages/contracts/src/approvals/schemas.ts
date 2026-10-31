import { z } from 'zod';
import { APPROVAL_STATUSES, RISK_LEVELS } from './types';

export const riskLevelSchema = z.enum(RISK_LEVELS);
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);

export const approvalActionDetailsSchema = z.object({
  toolName: z.string().min(1),
  summary: z.string().min(1),
  parametersRedacted: z.record(z.unknown()),
  requiredRole: z.string().optional(),
});

export const approvalRequestV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  effectKey: z.string().min(1),
  proposedActionHash: z.string().min(1),
  policyVersion: z.number().int().positive(),
  risk: riskLevelSchema,
  status: approvalStatusSchema,
  expiresAt: z.string().datetime(),
  details: approvalActionDetailsSchema.optional(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.string().optional(),
});

export const tenantActorSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().nullable(),
  roles: z.array(z.string()),
  requestId: z.string().min(1),
});

export const approvalDecisionCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().optional(),
  expectedVersion: z.number().int().nonnegative(),
  actor: tenantActorSchema,
});

export const approvalDecisionResultV1Schema = z.object({
  approvalId: z.string().min(1),
  status: approvalStatusSchema,
  decidedAt: z.string().datetime(),
  decidedBy: z.string().min(1),
});
