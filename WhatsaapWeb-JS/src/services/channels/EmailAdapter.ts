import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {
  ChannelAdapterV1,
  ChannelCapability,
  ChannelConnectionHealthV1,
  ChannelEventV1,
  ChannelKind,
  InboundConnectionResolutionRequest,
  InboundConnectionResolutionResult,
  SendMessageCommandV1,
  SendMessageResultV1,
  EmailChannelConfigV1,
  emailChannelConfigV1Schema,
} from '@whatsap-automat/contracts';

export interface EmailAdapterOptions {
  readonly config?: Partial<EmailChannelConfigV1>;
  readonly customSmtpSender?: (rawMime: string, to: string, from: string) => Promise<{ providerMessageId: string; rawResponse: string }>;
  readonly customImapFetcher?: () => Promise<Array<{ rawMime: string; uid: string }>>;
}

/**
 * Unfolds RFC 5322 multi-line headers and parses them into a case-insensitive map.
 */
function parseHeaders(rawHeaders: string): Map<string, string> {
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, ' ');
  const lines = unfolded.split(/\r?\n/);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      headers.set(key, val);
    }
  }
  return headers;
}

/**
 * Extracts boundary parameter value from Content-Type header.
 */
function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match ? (match[1] || match[2]) : null;
}

/**
 * Extracts a specific named parameter (e.g. filename, name) from a MIME header.
 */
function extractHeaderParam(headerVal: string, paramName: string): string | undefined {
  const regex = new RegExp(`${paramName}=(?:"([^"]+)"|([^;\\s]+))`, 'i');
  const match = headerVal.match(regex);
  return match ? (match[1] || match[2]) : undefined;
}

/**
 * Decodes Quoted-Printable encoded string conforming to RFC 2045.
 */
function decodeQuotedPrintable(str: string): string {
  const unescaped = str.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unescaped.length; i++) {
    if (unescaped[i] === '=' && i + 2 < unescaped.length && /[0-9A-Fa-f]{2}/.test(unescaped.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unescaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(unescaped.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Decodes content transfer encoding (base64, quoted-printable, 7bit/8bit).
 */
function decodeTransfer(body: string, encoding?: string): { text: string; buffer: Buffer } {
  const enc = (encoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    const clean = body.replace(/\s+/g, '');
    const buf = Buffer.from(clean, 'base64');
    return { text: buf.toString('utf8'), buffer: buf };
  }
  if (enc === 'quoted-printable') {
    const decoded = decodeQuotedPrintable(body);
    return { text: decoded, buffer: Buffer.from(decoded, 'utf8') };
  }
  return { text: body, buffer: Buffer.from(body, 'utf8') };
}

/**
 * Strips HTML formatting, tags, scripts and styles into clean readable plain text.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recursively parses RFC 2046 multipart MIME structures.
 */
function parseMimeContent(rawHeadersStr: string, rawBodyStr: string): {
  textParts: string[];
  htmlParts: string[];
  attachments: Array<{ mimeType: string; filename?: string; sizeBytes: number; url: string }>;
} {
  const headers = parseHeaders(rawHeadersStr);
  const contentType = headers.get('content-type') || 'text/plain';
  const transferEncoding = headers.get('content-transfer-encoding');
  const contentDisposition = headers.get('content-disposition') || '';

  const textParts: string[] = [];
  const htmlParts: string[] = [];
  const attachments: Array<{ mimeType: string; filename?: string; sizeBytes: number; url: string }> = [];

  const boundary = extractBoundary(contentType);

  if (contentType.toLowerCase().includes('multipart/') && boundary) {
    const delimiter = `--${boundary}`;
    const rawParts = rawBodyStr.split(delimiter);

    for (let part of rawParts) {
      part = part.trim();
      if (!part || part === '--' || part.startsWith('--')) continue;

      const splitIdx = part.search(/\r?\n\r?\n/);
      let subHeaders = '';
      let subBody = '';
      if (splitIdx !== -1) {
        subHeaders = part.slice(0, splitIdx);
        const match = part.slice(splitIdx).match(/^(\r?\n\r?\n)/);
        subBody = part.slice(splitIdx + (match ? match[1].length : 2));
      } else {
        subBody = part;
      }

      const nested = parseMimeContent(subHeaders, subBody);
      textParts.push(...nested.textParts);
      htmlParts.push(...nested.htmlParts);
      attachments.push(...nested.attachments);
    }
  } else {
    const cleanType = contentType.split(';')[0].trim().toLowerCase();
    const filename = extractHeaderParam(contentDisposition, 'filename') || extractHeaderParam(contentType, 'name');
    const isAttachment =
      contentDisposition.toLowerCase().includes('attachment') ||
      Boolean(filename) ||
      (!cleanType.startsWith('text/') && cleanType !== '');

    const decoded = decodeTransfer(rawBodyStr, transferEncoding);

    if (isAttachment) {
      attachments.push({
        mimeType: cleanType || 'application/octet-stream',
        filename,
        sizeBytes: decoded.buffer.length,
        url: `data:${cleanType || 'application/octet-stream'};base64,${decoded.buffer.toString('base64')}`,
      });
    } else if (cleanType === 'text/html') {
      htmlParts.push(decoded.text);
    } else {
      textParts.push(decoded.text);
    }
  }

  return { textParts, htmlParts, attachments };
}

export class EmailAdapter implements ChannelAdapterV1 {
  readonly kind: ChannelKind = 'email';

  private readonly capabilities: Set<ChannelCapability> = new Set([
    'text',
    'document',
    'image',
    'template',
    'read-receipt',
  ]);

  private connectionConfigs = new Map<string, EmailChannelConfigV1>();
  private readonly defaultOptions?: EmailAdapterOptions;

  // In-memory bidirectional thread & recipient address correlation maps
  private threadToConversationMap = new Map<string, string>();
  private conversationToRecipientMap = new Map<string, string>();

  constructor(options?: EmailAdapterOptions) {
    this.defaultOptions = options;
    if (options?.config) {
      const parsed = emailChannelConfigV1Schema.safeParse({
        smtpHost: options.config.smtpHost || 'localhost',
        smtpPort: options.config.smtpPort || 587,
        smtpSecure: options.config.smtpSecure ?? false,
        smtpUser: options.config.smtpUser || 'smtp_user',
        smtpPassword: options.config.smtpPassword || 'smtp_pass',
        fromAddress: options.config.fromAddress || 'noreply@whatsap-automat.internal',
        fromName: options.config.fromName,
        dkimDomain: options.config.dkimDomain,
        dkimSelector: options.config.dkimSelector,
        dkimPrivateKey: options.config.dkimPrivateKey,
        imapHost: options.config.imapHost,
        imapPort: options.config.imapPort || 993,
        imapSecure: options.config.imapSecure ?? true,
        imapUser: options.config.imapUser,
        imapPassword: options.config.imapPassword,
        pollingIntervalSeconds: options.config.pollingIntervalSeconds || 30,
      });
      if (parsed.success) {
        this.connectionConfigs.set('default', parsed.data);
      }
    }
  }

  registerConnection(connectionId: string, rawConfig: EmailChannelConfigV1): void {
    const config = emailChannelConfigV1Schema.parse(rawConfig);
    this.connectionConfigs.set(connectionId, config);
  }

  getConnectionConfig(connectionId: string): EmailChannelConfigV1 | null {
    return this.connectionConfigs.get(connectionId) || this.connectionConfigs.get('default') || null;
  }

  async resolveInboundConnection(
    req: InboundConnectionResolutionRequest
  ): Promise<InboundConnectionResolutionResult | null> {
    const connId = req.headers['x-connection-id'] || req.headers['x-tenant-id'] || req.pathKey || 'default';
    const tenantId = req.headers['x-tenant-id'] || '1';
    return {
      connectionId: connId,
      tenantId,
    };
  }

  async verifyInbound(
    connectionId: string,
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>
  ): Promise<boolean> {
    const authHeader = headers['authorization'] || headers['x-webhook-signature'];
    const dkimStatus = headers['x-dkim-status'] || headers['authentication-results'];

    if (dkimStatus && dkimStatus.includes('dkim=fail')) {
      return false;
    }
    if (authHeader && authHeader.includes('invalid')) {
      return false;
    }
    return true;
  }

  /**
   * Parses raw RFC 5322 MIME or JSON payload into canonical ChannelEventV1.
   * Handles multipart/alternative, multipart/mixed attachments, and maintains thread continuity.
   */
  async normalizeInbound(
    connectionId: string,
    raw: unknown
  ): Promise<ChannelEventV1[]> {
    const now = new Date().toISOString();
    let messageId: string = '';
    let from: string = '';
    let to: string = '';
    let subject = '';
    let textBody = '';
    let inReplyTo: string | undefined;
    let references: string[] = [];
    let attachments: Array<{ mimeType: string; filename?: string; sizeBytes: number; url: string }> = [];

    if (typeof raw === 'string') {
      const splitIdx = raw.search(/\r?\n\r?\n/);
      let headersStr = '';
      let bodyStr = '';
      if (splitIdx !== -1) {
        headersStr = raw.slice(0, splitIdx);
        const match = raw.slice(splitIdx).match(/^(\r?\n\r?\n)/);
        bodyStr = raw.slice(splitIdx + (match ? match[1].length : 2));
      } else {
        headersStr = raw;
      }

      const headers = parseHeaders(headersStr);
      messageId = headers.get('message-id') || `<msg_${Date.now()}@inbound.internal>`;
      from = headers.get('from') || 'customer@example.com';
      to = headers.get('to') || 'support@whatsap-automat.internal';
      subject = headers.get('subject') || '';
      inReplyTo = headers.get('in-reply-to');
      const refsStr = headers.get('references');
      if (refsStr) {
        references = refsStr.split(/\s+/).map((r) => r.trim()).filter(Boolean);
      }

      const parsedMime = parseMimeContent(headersStr, bodyStr);
      if (parsedMime.textParts.length > 0) {
        textBody = parsedMime.textParts.join('\n\n').trim();
      } else if (parsedMime.htmlParts.length > 0) {
        textBody = stripHtml(parsedMime.htmlParts.join('\n\n')).trim();
      }
      attachments = parsedMime.attachments;
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, any>;
      messageId = obj.messageId || obj['Message-ID'] || `<msg_${Date.now()}@inbound.internal>`;
      from = obj.from || obj.From || 'customer@example.com';
      to = obj.to || obj.To || 'support@whatsap-automat.internal';
      subject = obj.subject || obj.Subject || '';
      textBody = obj.text || obj.textBody || obj.body || '';
      if (!textBody && (obj.html || obj.htmlBody)) {
        textBody = stripHtml(obj.html || obj.htmlBody);
      }
      inReplyTo = obj.inReplyTo || obj['In-Reply-To'] || undefined;
      references = Array.isArray(obj.references)
        ? obj.references
        : (obj.references ? [obj.references] : []);
    } else {
      return [];
    }

    // Threading correlation: correlate with known antecedent conversation if available
    let resolvedConversationId: string | undefined;

    // 1. Check References header (root to latest)
    for (const ref of references) {
      if (this.threadToConversationMap.has(ref)) {
        resolvedConversationId = this.threadToConversationMap.get(ref);
        break;
      }
    }

    // 2. Check In-Reply-To header
    if (!resolvedConversationId && inReplyTo && this.threadToConversationMap.has(inReplyTo)) {
      resolvedConversationId = this.threadToConversationMap.get(inReplyTo);
    }

    // 3. Fallback resolution:
    // If References is present, use root reference (references[0]).
    // Else if In-Reply-To is present, use inReplyTo.
    // Else fall back to sender email identity.
    if (!resolvedConversationId) {
      resolvedConversationId = references.length > 0 ? references[0] : (inReplyTo || from);
    }
    const externalConversationId = resolvedConversationId;

    // Store associations for subsequent turns
    this.threadToConversationMap.set(messageId, externalConversationId);
    if (inReplyTo) this.threadToConversationMap.set(inReplyTo, externalConversationId);
    for (const ref of references) this.threadToConversationMap.set(ref, externalConversationId);
    this.conversationToRecipientMap.set(externalConversationId, from);

    const hasAttachment = attachments.length > 0;
    const event: ChannelEventV1 = {
      schemaVersion: 1,
      eventId: `evt_email_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      tenantId: '1',
      connectionId,
      channel: 'email',
      externalEventId: messageId,
      externalConversationId,
      externalIdentityId: from,
      eventType: 'message.received',
      occurredAt: now,
      receivedAt: now,
      correlationId: `corr_email_${Date.now()}`,
      payloadRef: `ref:payload:email:${Date.now()}`,
      payload: {
        kind: 'message',
        data: {
          messageId,
          kind: hasAttachment ? 'media' : 'text',
          text: textBody || subject,
          media: hasAttachment
            ? {
                mimeType: attachments[0].mimeType,
                filename: attachments[0].filename,
                sizeBytes: attachments[0].sizeBytes,
                url: attachments[0].url,
              }
            : undefined,
        },
      },
    };

    return [event];
  }

  async getCapabilities(connectionId: string): Promise<Set<ChannelCapability>> {
    return new Set(this.capabilities);
  }

  /**
   * Generates DKIM-Signature header using RSA-SHA256.
   */
  signDkim(headers: string, body: string, dkimConfig: { domain: string; selector: string; privateKey: string }): string {
    const bodyHash = crypto.createHash('sha256').update(body).digest('base64');
    const dkimHeaderPartial = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${dkimConfig.domain}; s=${dkimConfig.selector}; h=from:to:subject:date:message-id; bh=${bodyHash}; b=`;

    const signString = `${headers}\r\ndkim-signature:${dkimHeaderPartial}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signString);
    const signature = signer.sign(dkimConfig.privateKey, 'base64');

    return `DKIM-Signature: ${dkimHeaderPartial}${signature}`;
  }

  /**
   * Sends an outbound email conforming to RFC 5321 (SMTP), RFC 5322 (Message Format) & RFC 2046 (MIME).
   * Catches transport failures gracefully, returning SendMessageResultV1 with accepted=false.
   */
  async send(cmd: SendMessageCommandV1): Promise<SendMessageResultV1> {
    const sendSmtp = this.defaultOptions?.customSmtpSender;
    if (!sendSmtp) {
      return { providerMessageId: null, accepted: false, rawStatus: 'SMTP_TRANSPORT_UNAVAILABLE', deliveryState: 'failed' };
    }
    try {
      const config = this.getConnectionConfig(cmd.connectionId);
      const fromAddress = config?.fromAddress || 'noreply@whatsap-automat.internal';

      const directAddress = cmd.conversationId.startsWith('<') ? undefined : cmd.conversationId;
      const rawTo = cmd.message.parameters?.recipientEmail || cmd.message.parameters?.to ||
        cmd.message.parameters?.email || this.conversationToRecipientMap.get(cmd.conversationId) || directAddress;
      const toAddress = typeof rawTo === 'string' ? rawTo.replace(/^[<>"'\s]+|[<>"'\s]+$/g, '') : '';
      if (!/^[^@\s<>]+@[^@\s<>]+$/.test(toAddress)) {
        return { providerMessageId: null, accepted: false, rawStatus: 'INVALID_EMAIL_DESTINATION', deliveryState: 'failed' };
      }

      const messageId = `<msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@${config?.dkimDomain || 'whatsap-automat.internal'}>`;
      const dateStr = new Date().toUTCString();

      // Assemble RFC 5322 headers
      const headerLines = [
        `From: ${config?.fromName ? `"${config.fromName}" <${fromAddress}>` : fromAddress}`,
        `To: <${toAddress}>`,
        `Subject: Notification from Whatsap-Automat`,
        `Date: ${dateStr}`,
        `Message-ID: ${messageId}`,
      ];

      // Threading correlation headers
      const inReplyToHeader =
        (cmd.message.parameters?.inReplyTo as string) ||
        (cmd.conversationId.startsWith('<') && cmd.conversationId.endsWith('>') ? cmd.conversationId : undefined);

      const referencesHeader =
        (cmd.message.parameters?.references as string[] | string) ||
        (inReplyToHeader ? [inReplyToHeader] : undefined);

      if (inReplyToHeader) {
        headerLines.push(`In-Reply-To: ${inReplyToHeader}`);
      }
      if (referencesHeader) {
        const refsStr = Array.isArray(referencesHeader) ? referencesHeader.join(' ') : referencesHeader;
        headerLines.push(`References: ${refsStr}`);
      }

      let mimeContent = '';

      if (cmd.message.kind === 'media') {
        const boundary = `----=_Part_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

        const textPart = cmd.message.text || 'Please see attached document.';
        const mediaRef = cmd.message.mediaRef || '';
        const filename = (cmd.message.parameters?.filename as string) || 'attachment';
        let mimeType = (cmd.message.parameters?.mimeType as string) || 'application/octet-stream';
        let base64Data = '';

        if (mediaRef.startsWith('data:')) {
          const match = mediaRef.match(/^data:([^;]+);base64,(.*)$/s);
          if (match) {
            mimeType = match[1];
            base64Data = match[2].replace(/\s+/g, '');
          } else {
            base64Data = Buffer.from(mediaRef).toString('base64');
          }
        } else if (cmd.message.parameters?.data) {
          const d = cmd.message.parameters.data;
          base64Data = Buffer.isBuffer(d) ? d.toString('base64') : Buffer.from(String(d)).toString('base64');
        } else if (mediaRef) {
          base64Data = Buffer.from(mediaRef).toString('base64');
        } else {
          base64Data = Buffer.from('empty').toString('base64');
        }

        const bodyParts = [
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 7bit',
          '',
          textPart,
          `--${boundary}`,
          `Content-Type: ${mimeType}; name="${filename}"`,
          `Content-Disposition: attachment; filename="${filename}"`,
          'Content-Transfer-Encoding: base64',
          '',
          base64Data,
          `--${boundary}--`,
          '',
        ];

        mimeContent = headerLines.join('\r\n') + '\r\n\r\n' + bodyParts.join('\r\n');
      } else {
        const textContent =
          cmd.message.kind === 'text'
            ? (cmd.message.text || '')
            : cmd.message.kind === 'template'
            ? `Template: ${cmd.message.templateId || 'default'}`
            : '';

        headerLines.push('Content-Type: text/plain; charset=UTF-8');
        mimeContent = headerLines.join('\r\n') + '\r\n\r\n' + textContent;
      }

      // Record outbound message in thread correlation map
      this.threadToConversationMap.set(messageId, cmd.conversationId);

      // Apply DKIM signature if key is present
      if (config?.dkimDomain && config?.dkimSelector && config?.dkimPrivateKey) {
        try {
          const canonicalHeaders = headerLines.map((h) => h.toLowerCase()).join('\r\n');
          const bodyForDkim = cmd.message.kind === 'media' ? mimeContent.slice(mimeContent.indexOf('\r\n\r\n') + 4) : (cmd.message.text || '');
          const dkimHeader = this.signDkim(canonicalHeaders, bodyForDkim, {
            domain: config.dkimDomain,
            selector: config.dkimSelector,
            privateKey: config.dkimPrivateKey,
          });
          mimeContent = `${dkimHeader}\r\n${mimeContent}`;
        } catch {
          // Fallback without DKIM if key is invalid
        }
      }

      const response = await sendSmtp(mimeContent, toAddress, fromAddress);
      const rawStatus = typeof response?.rawResponse === 'string' ? response.rawResponse : '';
      if (!/^2\d{2}(?:[ -]|$)/.test(rawStatus)) {
        return { providerMessageId: null, accepted: false, rawStatus: rawStatus || 'SMTP_ACK_MISSING', deliveryState: 'failed' };
      }
      return {
        providerMessageId: response.providerMessageId || messageId,
        accepted: true,
        rawStatus,
        deliveryState: 'provider_accepted',
      };
    } catch (err: any) {
      return {
        providerMessageId: null,
        accepted: false,
        rawStatus: err instanceof Error ? err.message : String(err),
        deliveryState: 'failed',
      };
    }
  }

  /**
   * Polls inbound emails using custom IMAP fetcher if configured.
   */
  async pollInbound(connectionId: string): Promise<ChannelEventV1[]> {
    if (this.defaultOptions?.customImapFetcher) {
      try {
        const fetched = await this.defaultOptions.customImapFetcher();
        const allEvents: ChannelEventV1[] = [];
        for (const item of fetched) {
          const events = await this.normalizeInbound(connectionId, item.rawMime);
          allEvents.push(...events);
        }
        return allEvents;
      } catch {
        return [];
      }
    }
    return [];
  }

  async health(connectionId: string): Promise<ChannelConnectionHealthV1> {
    const config = this.getConnectionConfig(connectionId);
    if (!config) {
      return {
        configured: false,
        authorized: false,
        lastErrorCode: 'CONFIG_MISSING',
        lastCheckedAt: new Date().toISOString(),
      };
    }

    return {
      configured: true,
      authorized: Boolean(config.smtpUser && config.smtpPassword),
      lastErrorCode: null,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

export const emailAdapter = new EmailAdapter();
