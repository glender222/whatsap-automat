/**
 * Channel core types for Whatsap-Automat v0.4
 * Conforms to Blueprint Section 5.1 & Section 5.2
 */

export const CHANNEL_KINDS = [
  'whatsapp-cloud',
  'instagram',
  'messenger',
  'telegram',
] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_CAPABILITIES = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'template',
  'interactive',
  'read-receipt',
  'typing',
] as const;

export type ChannelCapability = (typeof CHANNEL_CAPABILITIES)[number];

export const DELIVERY_STATES = [
  'pending',
  'dispatched',
  'provider_accepted',
  'delivered',
  'read',
  'failed',
  'unknown_delivery',
  'cancelled',
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const CHANNEL_EVENT_TYPES = [
  'message.received',
  'message.status',
  'interaction.received',
  'connection.status',
] as const;

export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];
