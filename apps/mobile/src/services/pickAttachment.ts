import { readPickedAttachment, SEND_ATTACHMENT_TYPES, type OutboundAttachment } from './outboundAttachment';

export async function pickAttachment(signal: AbortSignal): Promise<OutboundAttachment | null> {
  if (signal.aborted) return null;
  const file = await new Promise<File | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SEND_ATTACHMENT_TYPES.join(',');
    input.hidden = true;
    const cancel = () => finish(null);
    const finish = (result: File | null) => {
      signal.removeEventListener('abort', cancel);
      input.remove();
      resolve(result);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', cancel, { once: true });
    signal.addEventListener('abort', cancel, { once: true });
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      signal.removeEventListener('abort', cancel);
      input.remove();
      reject(error);
    }
  });
  if (!file) return null;
  return readPickedAttachment(file, { name: file.name, mimeType: file.type, size: file.size }, signal);
}
