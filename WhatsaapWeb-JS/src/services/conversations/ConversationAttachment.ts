import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { withCompatibleVideo } from '../whatsapp/VideoTranscode';
import type { MetaCloudClient } from '../whatsapp/meta/MetaCloudClient';

export type AttachmentFile = { path: string; mimetype: string; originalname: string };
type AttachmentKind = 'image' | 'video' | 'audio' | 'document';
type AttachmentInput = { file: AttachmentFile; caption: string; forceDocument: boolean };
export type UploadedAttachment = {
  id: string; kind: AttachmentKind; mimetype: string; filename: string; size: number;
};

export class ConversationAttachmentError extends Error {
  constructor(readonly reasonCode: string, message: string, readonly retryable = false) { super(message); }
}

const images = new Set(['image/jpeg', 'image/png']);
const audio = new Set(['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg']);
const videos = new Set([
  'video/mp4', 'video/webm', 'video/3gpp', 'video/quicktime', 'video/mpeg', 'video/x-msvideo',
  'video/mov', 'video/avi', 'video/mkv', 'video/x-ms-wmv', 'video/x-flv', 'video/x-matroska',
]);
const documents = new Set([
  'text/plain', 'application/pdf', 'application/msword', 'application/vnd.ms-powerpoint', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const maxBytes = { image: 5_000_000, video: 16_000_000, audio: 16_000_000, document: 100_000_000 };

export async function inspectConversationAttachment({ file, caption, forceDocument }: AttachmentInput) {
  const mimetype = file.mimetype.toLowerCase();
  const detected = images.has(mimetype) ? 'image' : audio.has(mimetype) ? 'audio' :
    videos.has(mimetype) ? 'video' : documents.has(mimetype) ? 'document' : undefined;
  if (!detected) throw new ConversationAttachmentError('ATTACHMENT_TYPE_UNSUPPORTED', 'Unsupported attachment media type.');
  const kind: AttachmentKind = forceDocument ? 'document' : detected;
  if (kind === 'audio' && caption) {
    throw new ConversationAttachmentError('ATTACHMENT_CAPTION_UNSUPPORTED', 'Audio messages do not support a caption.');
  }
  const filename = file.originalname;
  const trimmedName = filename.trim();
  if (!trimmedName || trimmedName === '.' || trimmedName === '..' || filename.length > 180 || /[/\\\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(filename)) {
    throw new ConversationAttachmentError('ATTACHMENT_FILENAME_INVALID', 'Invalid attachment filename.');
  }

  const size = (await stat(file.path)).size;
  if (size < 1 || (kind !== 'video' && size > maxBytes[detected])) {
    throw new ConversationAttachmentError('ATTACHMENT_SIZE_INVALID', 'The attachment is empty or exceeds the size limit.');
  }

  const bytes = createHash('sha256');
  for await (const chunk of createReadStream(file.path)) bytes.update(chunk);
  // Text commands exclude NUL. This separates attachment hashes from all historical text hashes.
  const hash = createHash('sha256').update('\0attachment-v1\0')
    .update(JSON.stringify([bytes.digest('hex'), mimetype, filename, kind, forceDocument, caption])).digest('hex');
  return { hash, kind, file: { ...file, mimetype, originalname: filename } };
}

export async function uploadConversationAttachment(
  client: MetaCloudClient, kind: AttachmentKind, file: AttachmentFile,
): Promise<UploadedAttachment> {
  const upload = async (attachment: AttachmentFile) => {
    const { size } = await stat(attachment.path);
    if (size < 1 || size > maxBytes[kind]) {
      throw new ConversationAttachmentError('ATTACHMENT_SIZE_INVALID', 'The final attachment exceeds the size limit.');
    }
    let id: string;
    try {
      ({ mediaId: id } = await client.uploadMedia(attachment, { redirect: 'error' }));
    } catch (error) {
      const status = (error as { providerStatusCode?: number } | undefined)?.providerStatusCode;
      if (status === 400 || status === 413 || status === 415) {
        throw new ConversationAttachmentError('ATTACHMENT_REJECTED', 'WhatsApp rejected the attachment.');
      }
      throw new ConversationAttachmentError('ATTACHMENT_UPLOAD_UNAVAILABLE', 'Attachment upload temporarily unavailable.', true);
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new ConversationAttachmentError('ATTACHMENT_UPLOAD_UNAVAILABLE', 'Attachment upload acknowledgement unavailable.', true);
    }
    return { id, kind, mimetype: attachment.mimetype, filename: attachment.originalname, size };
  };

  if (kind !== 'video') return upload(file);
  try {
    return await withCompatibleVideo(file, upload, { inspectMp4: true });
  } catch (error) {
    if (error instanceof ConversationAttachmentError) throw error;
    const videoError = error as { code?: string; statusCode?: number };
    throw new ConversationAttachmentError(videoError.code ?? 'ATTACHMENT_VIDEO_INVALID',
      videoError.statusCode === 503 ? 'Video processing temporarily unavailable.' : 'The video could not be processed.',
      videoError.statusCode === 503);
  }
}
