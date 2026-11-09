import type { AttachmentBytes } from './attachmentData';

export async function saveAttachment(file: AttachmentBytes, filename: string, isActive: () => boolean): Promise<boolean> {
  if (!isActive()) return false;
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
    return true;
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
