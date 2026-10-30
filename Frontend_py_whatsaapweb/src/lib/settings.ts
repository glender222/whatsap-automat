// Helper simple para persistir y observar settings del frontend
type SettingsKey = 'autoDownload_images_files' | 'autoDownload_documents' | 'bot_modality';

export function getAutoDownloadImagesFiles(): boolean {
  try {
    return localStorage.getItem('autoDownload_images_files') === 'true';
  } catch (e) {
    return false;
  }
}

export function getAutoDownloadDocuments(): boolean {
  try {
    return localStorage.getItem('autoDownload_documents') === 'true';
  } catch (e) {
    return false;
  }
}

export function getBotModality(): 'options' | 'words' | null {
  try {
    const value = localStorage.getItem('bot_modality');
    return (value === 'options' || value === 'words') ? value : null;
  } catch (e) {
    return null;
  }
}

function emitChange(key: SettingsKey, value: boolean | string | null) {
  try {
    const ev = new CustomEvent('settings:change', { detail: { key, value } });
    window.dispatchEvent(ev);
  } catch (e) {
    // ignore
  }
}

export function setAutoDownloadImagesFiles(v: boolean) {
  try {
    localStorage.setItem('autoDownload_images_files', String(v));
  } catch (e) {}
  emitChange('autoDownload_images_files', v);
}

export function setAutoDownloadDocuments(v: boolean) {
  try {
    localStorage.setItem('autoDownload_documents', String(v));
  } catch (e) {}
  emitChange('autoDownload_documents', v);
}

export function setBotModality(v: 'options' | 'words' | null) {
  try {
    if (v === null) {
      localStorage.removeItem('bot_modality');
    } else {
      localStorage.setItem('bot_modality', v);
    }
  } catch (e) {}
  emitChange('bot_modality', v);
}

export function onSettingsChange(cb: (detail: { key: SettingsKey; value: boolean | string | null }) => void) {
  const handler = (ev: Event) => {
    const e = ev as CustomEvent;
    if (e?.detail) cb(e.detail as any);
  };
  window.addEventListener('settings:change', handler as EventListener);
  return () => window.removeEventListener('settings:change', handler as EventListener);
}

export default {
  getAutoDownloadImagesFiles,
  getAutoDownloadDocuments,
  getBotModality,
  setAutoDownloadImagesFiles,
  setAutoDownloadDocuments,
  setBotModality,
  onSettingsChange,
};
