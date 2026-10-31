import { z } from 'zod';
import {
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGER_TYPES,
  EXECUTION_STATUSES,
} from './types';

export const automationTriggerTypeSchema = z.enum(AUTOMATION_TRIGGER_TYPES);
export const automationStatusSchema = z.enum(AUTOMATION_STATUSES);
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);

export const automationTriggerV1Schema = z.object({
  type: automationTriggerTypeSchema,
  config: z.record(z.unknown()),
});

export const automationDefinitionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: automationTriggerV1Schema,
  graphId: z.string().min(1),
  graphVersion: z.number().int().positive(),
  status: automationStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const executionRecordV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowRunId: z.string().min(1),
  correlationId: z.string().min(1),
  status: executionStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().optional(),
  lastErrorMessage: z.string().optional(),
});
