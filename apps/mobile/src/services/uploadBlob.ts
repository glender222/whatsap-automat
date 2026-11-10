import type { OutboundAttachment } from './outboundAttachment';

export function uploadBlob(file: OutboundAttachment): Blob {
  return new Blob([file.bytes], { type: file.mimeType });
}
