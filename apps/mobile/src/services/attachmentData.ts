export interface MobileAttachment {
  id: string;
  mimeType: string;
  filename?: string;
  sizeBytes?: number;
}

export interface AttachmentBytes {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const knownExtensions = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'],
  ['application/pdf', 'pdf'], ['text/plain', 'txt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg'], ['video/mp4', 'mp4'],
]);

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
}

export function parseAttachments(values: unknown[]): MobileAttachment[] {
  return values.flatMap((value) => {
    const item = value as Partial<MobileAttachment> | null;
    if (!isAttachmentId(item?.id) || typeof item?.mimeType !== 'string') return [];
    const mimeType = item.mimeType.toLowerCase();
    return [{ id: item.id, mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream',
      filename: typeof item.filename === 'string' ? item.filename.slice(0, 255) : undefined,
      sizeBytes: typeof item.sizeBytes === 'number' && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 ? item.sizeBytes : undefined }];
  });
}

export function safeAttachmentName(filename: string | undefined, mimeType: string) {
  const base = filename?.split(/[/\\]/).at(-1)?.replace(/\.[^.]*$/, '')
    .replace(/[^\p{L}\p{N}_ -]/gu, '_').trim().slice(0, 100) || 'archivo-adjunto';
  return `${base}.${knownExtensions.get(mimeType) ?? 'bin'}`;
}

export function downloadMimeType(value: string | null) {
  const mimeType = value?.split(';', 1)[0].trim().toLowerCase();
  return mimeType && knownExtensions.has(mimeType) ? mimeType : 'application/octet-stream';
}

export function isPreviewImage(mimeType: string) {
  return knownExtensions.has(mimeType) && mimeType.startsWith('image/');
}

export function isMatchingImage({ bytes, mimeType }: AttachmentBytes) {
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const prefix = String.fromCharCode(...bytes.subarray(0, 12));
  if (mimeType === 'image/gif') return prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a');
  return mimeType === 'image/webp' && prefix.startsWith('RIFF') && prefix.slice(8) === 'WEBP';
}
