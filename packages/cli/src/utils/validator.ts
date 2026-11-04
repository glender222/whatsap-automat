import * as fs from 'node:fs';
import { z } from 'zod';

export const FORBIDDEN_PERMISSION_SCOPES = [
  'database.raw_query',
  'system.process',
  'secrets.master_key',
  'filesystem.root',
  'network.raw_socket',
] as const;

export const fallbackManifestSchema = z.object({
  name: z.string().regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/, 'Name must be lowercase alphanumeric with hyphens, underscores, dots, or npm scope'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?$/, 'Version must be semver format (e.g. 1.0.0)'),
  description: z.string().min(1).max(500).optional().default(''),
  type: z.enum(['channel', 'tool', 'ui']),
  entrypoint: z.string().min(1),
  permissions: z.array(z.string()).default([]),
  author: z.union([
    z.string().min(1),
    z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      url: z.string().url().optional(),
    }),
  ]).optional(),
  license: z.string().default('MIT'),
  channel: z.object({
    kind: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    webhookPath: z.string().optional(),
  }).optional(),
  tool: z.object({
    name: z.string().min(1),
    riskLevel: z.enum(['read', 'write', 'send', 'financial', 'destructive']).default('read'),
    parameters: z.record(z.unknown()).optional(),
  }).optional(),
  ui: z.object({
    slots: z.array(z.string()).min(1),
    entrypointHtml: z.string().optional(),
  }).optional(),
  slots: z.array(z.string()).optional(),
  settings: z.record(z.unknown()).optional(),
});

export type ExtensionManifest = z.infer<typeof fallbackManifestSchema>;

export interface ValidationOutput {
  valid: boolean;
  manifest?: ExtensionManifest;
  errors: string[];
  warnings: string[];
}

export function validateManifestFile(filePath: string, _options: { strict?: boolean } = {}): ValidationOutput {
  const errors: string[] = [];
  const warnings: string[] = [];

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    return { valid: false, errors: [`Could not read file: ${err.message}`], warnings };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (err: any) {
    return { valid: false, errors: [`Invalid JSON syntax: ${err.message}`], warnings };
  }

  let schemaToUse: any = fallbackManifestSchema;
  try {
    const contracts = require('@whatsap-automat/contracts');
    if (contracts.extensionManifestSchema) {
      schemaToUse = contracts.extensionManifestSchema;
    }
  } catch {
    // Fallback schema is used
  }

  const parseResult = schemaToUse.safeParse(parsedJson);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      const fieldPath = issue.path.join('.') || 'root';
      errors.push(`[${fieldPath}]: ${issue.message}`);
    }
    return { valid: false, errors, warnings };
  }

  const manifest = parseResult.data as ExtensionManifest;

  // SEC-009 Security scope check
  if (Array.isArray(manifest.permissions)) {
    for (const perm of manifest.permissions) {
      if (FORBIDDEN_PERMISSION_SCOPES.includes(perm as any)) {
        errors.push(`[permissions]: Forbidden scope "${perm}" is not permitted for extensions (SEC-009)`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  return { valid: true, manifest, errors, warnings };
}
