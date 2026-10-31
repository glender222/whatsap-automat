import { ChannelAdapterV1, InboundConnectionResolutionRequest, InboundConnectionResolutionResult } from '../channels/port';
import { ChannelCapability, ChannelKind } from '../channels/types';
import { ChannelEventV1 } from '../channels/events';
import { SendMessageCommandV1, SendMessageResultV1 } from '../channels/commands';
import { ChannelConnectionHealthV1 } from '../channels/connections';
import { LegacyMessageChannelPort } from './legacyContracts.types';
import { mapCanonicalCommandToLegacyOutbound, toCanonicalDeliveryState } from './legacyConversationMapper';

export interface LegacyChannelBridgeOptions {
  readonly kind?: ChannelKind;
  readonly defaultTenantId?: string;
  readonly defaultConnectionId?: string;
  readonly externalContactIdResolver?: (cmd: SendMessageCommandV1) => Promise<string> | string;
  readonly externalConversationIdResolver?: (cmd: SendMessageCommandV1) => Promise<string> | string;
}

/**
 * Adapter Bridge: wraps legacy MessageChannelPort into canonical ChannelAdapterV1 port
 * Conforms to Blueprint Section 5.2
 */
export class LegacyChannelAdapterBridge implements ChannelAdapterV1 {
  public readonly kind: ChannelKind;
  private readonly legacyPort: LegacyMessageChannelPort;
  private readonly options: LegacyChannelBridgeOptions;

  constructor(legacyPort: LegacyMessageChannelPort, options: LegacyChannelBridgeOptions = {}) {
    this.legacyPort = legacyPort;
    this.kind = options.kind ?? 'whatsapp-cloud';
    this.options = options;
  }

  async resolveInboundConnection(
    req: InboundConnectionResolutionRequest
  ): Promise<InboundConnectionResolutionResult | null> {
    const connectionHeader = req.headers['x-connection-id'];
    const tenantHeader = req.headers['x-tenant-id'] || req.headers['x-company-id'];

    if (connectionHeader && tenantHeader) {
      return {
        connectionId: connectionHeader,
        tenantId: tenantHeader,
      };
    }

    if (this.options.defaultConnectionId && this.options.defaultTenantId) {
      return {
        connectionId: this.options.defaultConnectionId,
        tenantId: this.options.defaultTenantId,
      };
    }

    return null;
  }

  async verifyInbound(
    _connectionId: string,
    rawBody: Uint8Array,
    _headers: Readonly<Record<string, string | undefined>>
  ): Promise<boolean> {
    return rawBody.length > 0;
  }

  async normalizeInbound(
    _connectionId: string,
    _raw: unknown
  ): Promise<ChannelEventV1[]> {
    return [];
  }

  async getCapabilities(_connectionId: string): Promise<Set<ChannelCapability>> {
    return new Set<ChannelCapability>([
      'text',
      'image',
      'audio',
      'video',
      'document',
      'template',
      'interactive',
      'read-receipt',
      'typing',
    ]);
  }

  async send(cmd: SendMessageCommandV1): Promise<SendMessageResultV1> {
    const externalContactId = this.options.externalContactIdResolver
      ? await this.options.externalContactIdResolver(cmd)
      : cmd.conversationId;

    const externalConversationId = this.options.externalConversationIdResolver
      ? await this.options.externalConversationIdResolver(cmd)
      : cmd.conversationId;

    const legacyDto = mapCanonicalCommandToLegacyOutbound(cmd, {
      externalContactId,
      externalConversationId,
    });

    const sendResult = await this.legacyPort.sendMessage(legacyDto);
    const deliveryState = toCanonicalDeliveryState(sendResult.status);

    return {
      providerMessageId: sendResult.providerMessageId || null,
      accepted: deliveryState !== 'failed',
      rawStatus: sendResult.status,
      deliveryState,
    };
  }

  async health(_connectionId: string): Promise<ChannelConnectionHealthV1> {
    try {
      const statusResult = await this.legacyPort.getStatus();
      return {
        configured: Boolean(statusResult.connected),
        authorized: Boolean(statusResult.authenticated),
        lastErrorCode: statusResult.connected ? null : 'DISCONNECTED',
        lastCheckedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        configured: false,
        authorized: false,
        lastErrorCode: err instanceof Error ? err.message : 'HEALTH_CHECK_FAILED',
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}
