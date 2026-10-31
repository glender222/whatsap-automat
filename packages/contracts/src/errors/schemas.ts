import { z } from 'zod';
import { StandardErrorCode } from './codes';

export const standardErrorCodeSchema = z.nativeEnum(StandardErrorCode);

export const invalidParamDetailSchema = z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
});

export const problemDetailsV1Schema = z.object({
  type: z.string().url().or(z.string().min(1)),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1),
  instance: z.string().min(1),
  code: standardErrorCodeSchema,
  correlationId: z.string().min(1),
  invalidParams: z.array(invalidParamDetailSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ProblemDetailsV1SchemaType = z.infer<typeof problemDetailsV1Schema>;
