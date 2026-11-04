import { z } from 'zod';

export const emailChannelConfigV1Schema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive().default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().min(1),
  smtpPassword: z.string().min(1),
  fromAddress: z.string().email(),
  fromName: z.string().optional(),
  dkimDomain: z.string().optional(),
  dkimSelector: z.string().optional(),
  dkimPrivateKey: z.string().optional(),
  imapHost: z.string().optional(),
  imapPort: z.number().int().positive().default(993).optional(),
  imapSecure: z.boolean().default(true).optional(),
  imapUser: z.string().optional(),
  imapPassword: z.string().optional(),
  pollingIntervalSeconds: z.number().int().min(5).default(30).optional(),
});

export type EmailChannelConfigV1 = z.infer<typeof emailChannelConfigV1Schema>;

export const emailMimeHeadersV1Schema = z.object({
  messageId: z.string().min(1),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
  subject: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  date: z.string(),
});

export type EmailMimeHeadersV1 = z.infer<typeof emailMimeHeadersV1Schema>;

export const emailInboundMimeEventV1Schema = z.object({
  messageId: z.string().min(1),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
  subject: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
  receivedAt: z.string().datetime().default(() => new Date().toISOString()),
});

export type EmailInboundMimeEventV1 = z.infer<typeof emailInboundMimeEventV1Schema>;
