import { getDocumentAsync } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { readPickedAttachment, SEND_ATTACHMENT_TYPES, type OutboundAttachment } from './outboundAttachment';

export async function pickAttachment(signal: AbortSignal): Promise<OutboundAttachment | null> {
  if (signal.aborted) return null;
  const result = await getDocumentAsync({ type: SEND_ATTACHMENT_TYPES, multiple: false, copyToCacheDirectory: false });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset || !/^(file|content):/.test(asset.uri)) throw new Error('No se pudo leer el archivo seleccionado.');
  const source = new File(asset.uri);
  try {
    if (signal.aborted) return null;
    return await readPickedAttachment(source, { name: asset.name, mimeType: asset.mimeType || source.type, size: asset.size }, signal);
  } finally {
    // iOS imports a system-managed temporary copy even when Expo cache copying is off.
    if (Platform.OS === 'ios') {
      const temporaryDirectory = new Directory(Paths.document.parentDirectory, 'tmp').uri.replace(/\/?$/, '/');
      if (source.uri.startsWith(temporaryDirectory)) {
        try { source.delete(); } catch { /* iOS also cleans its imported copy when the app exits. */ }
      }
    }
  }
}
