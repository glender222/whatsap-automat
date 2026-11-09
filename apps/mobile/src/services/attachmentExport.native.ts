import { Directory } from 'expo-file-system';
import type { AttachmentBytes } from './attachmentData';

export async function saveAttachment(file: AttachmentBytes, filename: string, isActive: () => boolean): Promise<boolean> {
  if (!isActive()) return false;
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (/CANCELLED/.test(String((error as { code?: string })?.code))) return false;
    throw error;
  }
  if (!isActive()) return false;
  const destination = directory.createFile(filename, file.mimeType);
  let completed = false;
  try {
    await destination.write(file.bytes);
    completed = isActive();
    return completed;
  } finally {
    if (!completed && destination.exists) destination.delete();
  }
}
