import { Blob as ExpoBlob } from 'expo-blob';
import type { OutboundAttachment } from './outboundAttachment';

export function uploadBlob(file: OutboundAttachment): Blob {
  // Expo's native multipart serializer uses the name on the binary part.
  return Object.assign(new ExpoBlob([file.bytes], { type: file.mimeType }), { name: file.filename }) as unknown as Blob;
}
