import { ChannelEventV1 } from './events';
import { SendMessageCommandV1, SendMessageResultV1 } from './commands';
import { ChannelConnectionHealthV1 } from './connections';
import { ChannelCapability, ChannelKind } from './types';

export interface InboundConnectionResolutionRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly pathKey: string | null;
  readonly rawBody: Uint8Array;
}

export interface InboundConnectionResolutionResult {
  readonly connectionId: string;
  readonly tenantId: string;
}

/**
 * Port interface for channel adapters in Hexagonal Architecture
 * Blueprint Section 5.2
 */
export interface ChannelAdapterV1 {
  readonly kind: ChannelKind;

  resolveInboundConnection(
    req: InboundConnectionResolutionRequest
  ): Promise<InboundConnectionResolutionResult | null>;

  verifyInbound(
    connectionId: string,
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>
  ): Promise<boolean>;

  normalizeInbound(
    connectionId: string,
    raw: unknown
  ): Promise<ChannelEventV1[]>;

  getCapabilities(connectionId: string): Promise<Set<ChannelCapability>>;

  send(cmd: SendMessageCommandV1): Promise<SendMessageResultV1>;

  health(connectionId: string): Promise<ChannelConnectionHealthV1>;
}
