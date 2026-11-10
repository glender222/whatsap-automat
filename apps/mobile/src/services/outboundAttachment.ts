export interface OutboundAttachment {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly filename: string;
  readonly mimeType: string;
}

const mobileLimit = 10 * 1024 * 1024;
const formats = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'],
  ['audio/aac', 'aac'], ['audio/amr', 'amr'], ['audio/mpeg', 'mp3'], ['audio/mp4', 'm4a'], ['audio/ogg', 'ogg'],
  ['video/mp4', 'mp4'], ['video/webm', 'webm'], ['video/3gpp', '3gp'], ['video/quicktime', 'mov'],
  ['video/mpeg', 'mpeg'], ['video/x-msvideo', 'avi'], ['video/mov', 'mov'], ['video/avi', 'avi'],
  ['video/mkv', 'mkv'], ['video/x-ms-wmv', 'wmv'], ['video/x-flv', 'flv'], ['video/x-matroska', 'mkv'],
  ['text/plain', 'txt'], ['application/pdf', 'pdf'], ['application/msword', 'doc'],
  ['application/vnd.ms-powerpoint', 'ppt'], ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
]);

export const SEND_ATTACHMENT_TYPES = [...formats.keys()];
export const MAX_ATTACHMENT_CAPTION_LENGTH = 1024;

export function canUseAttachmentCaption(mimeType: string) {
  return !mimeType.startsWith('audio/');
}

export function outboundAttachmentDetails(name: string, rawType: string | undefined) {
  const mimeType = rawType?.trim().toLowerCase() ?? '';
  const extension = formats.get(mimeType);
  if (!extension) throw new Error('Selecciona un formato de archivo compatible.');
  // Expo encodes multipart filenames. Keep a portable name for both clients.
  const base = name.split(/[/\\]/).at(-1)?.replace(/\.[^.]*$/, '').normalize('NFKD')
    .replace(/\p{Mark}/gu, '').replace(/[^a-z\d_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'archivo';
  const limit = mimeType.startsWith('image/') ? 5_000_000 : mobileLimit;
  return { filename: `${base}.${extension}`, mimeType, limit };
}

export function validateAttachmentSize(size: number, limit: number) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('El archivo está vacío o su tamaño no es válido.');
  if (size > limit) throw new Error(limit === 5_000_000 ? 'La imagen supera el límite de 5 MB.' : 'El archivo supera el límite de 10 MiB.');
}

export async function readPickedAttachment(
  source: { stream(): ReadableStream<Uint8Array> },
  asset: { name: string; mimeType?: string; size?: number },
  signal: AbortSignal,
): Promise<OutboundAttachment | null> {
  if (signal.aborted) return null;
  const { filename, mimeType, limit } = outboundAttachmentDetails(asset.name, asset.mimeType);
  if (asset.size !== undefined) validateAttachmentSize(asset.size, limit);
  const reader = source.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abortRead = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abortRead, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value.byteLength) continue;
      size += chunk.value.byteLength;
      if (size > limit) validateAttachmentSize(size, limit);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
  if (signal.aborted) return null;
  validateAttachmentSize(size, limit);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, filename, mimeType };
}
