import { z } from 'zod';

export const EXTENSION_TYPES = ['channel', 'tool', 'ui'] as const;
export type ExtensionType = (typeof EXTENSION_TYPES)[number];
export const extensionTypeSchema = z.enum(EXTENSION_TYPES);

export const EXTENSION_PERMISSIONS = [
  'network:outbound',
  'conversations:read',
  'conversations:write',
  'messages:send',
  'channels:read',
  'storage:read',
  'storage:write',
  'channel:inbound',
  'channel:send',
  'webhook:receive',
  'tool:execute',
  'ui:slot:inbox',
  'ui:rpc',
] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];
export const extensionPermissionSchema = z.enum(EXTENSION_PERMISSIONS);

export const UI_SLOTS = [
  'conversation.sidebar',
  'conversation.action',
  'inbox.toolbar',
  'settings.panel',
  'dashboard.widget',
  'inbox-sidebar',
] as const;
export type UiSlot = (typeof UI_SLOTS)[number];
export const uiSlotSchema = z.enum(UI_SLOTS);

export const extensionAuthorSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  }),
]);
export type ExtensionAuthor = z.infer<typeof extensionAuthorSchema>;

export const extensionManifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/, 'Identifier must be kebab-case or scoped name (e.g. acme/my-tool)')
      .optional(),
    name: z.string().regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/, 'Name must be lowercase alphanumeric with hyphens, underscores, dots, or npm scope'),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/, 'Must be valid SemVer (e.g. 1.0.0)'),
    type: extensionTypeSchema,
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(512).default(''),
    author: extensionAuthorSchema.optional(),
    license: z.string().default('MIT'),
    entrypoint: z.string().min(1),
    permissions: z.array(z.string()).default([]),
    slots: z.array(uiSlotSchema).optional(),
    capabilities: z.array(z.string()).optional(),
    minRuntimeVersion: z.string().default('^0.4.0'),
    configSchema: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    channel: z
      .object({
        kind: z.string().min(1),
        capabilities: z.array(z.string()).default([]),
        webhookPath: z.string().optional(),
      })
      .optional(),
    tool: z
      .object({
        name: z.string().min(1),
        riskLevel: z.enum(['read', 'write', 'send', 'financial', 'destructive']).default('read'),
        parameters: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    ui: z
      .object({
        slots: z.array(z.string()).min(1),
        entrypointHtml: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (manifest) => {
      if (manifest.type === 'ui') {
        const hasTopSlots = Array.isArray(manifest.slots) && manifest.slots.length > 0;
        const hasUiSlots = Boolean(manifest.ui?.slots && Array.isArray(manifest.ui.slots) && manifest.ui.slots.length > 0);
        return hasTopSlots || hasUiSlots;
      }
      return true;
    },
    {
      message: "Extension of type 'ui' must specify at least one valid slot in 'slots' or 'ui.slots'",
      path: ['slots'],
    }
  );

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

export interface ExtensionValidationResult {
  readonly valid: boolean;
  readonly manifest?: ExtensionManifest;
  readonly errors?: string[];
}

export function validateExtensionManifest(data: unknown): ExtensionValidationResult {
  const result = extensionManifestSchema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
  }
  return {
    valid: true,
    manifest: result.data,
  };
}
