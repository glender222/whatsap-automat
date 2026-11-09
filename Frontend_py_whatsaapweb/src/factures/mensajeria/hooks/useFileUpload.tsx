import { useCallback, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type SetStateAction } from 'react';
import { isAxiosError } from 'axios';
import { api } from '../../../shared/axios/http';
import type { FilePreview } from '../../../shared/types/wsp';
import { getMediaErrorMessage } from '../services/mediaService';

export type SelectedAttachment = FilePreview & { forceDocument: boolean };

function getFileType(file: File): FilePreview['type'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

function validateFile(file: File) {
  if (file.size > 100 * 1024 * 1024) return 'El archivo es demasiado grande (máximo 100 MB).';
  if (file.type.startsWith('image/') && !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'].includes(file.type)) {
    return 'Formato de imagen no soportado. Usa JPEG, PNG, GIF, WEBP o BMP.';
  }
  if (file.type.startsWith('audio/') && !['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp3', 'audio/aac'].includes(file.type)) {
    return 'Formato de audio no soportado. Usa MP3, OGG, WAV o AAC.';
  }
  return null;
}

export function useFileUpload({
  selectedFile, setAttachmentDraft, selectAttachment,
}: {
  selectedFile: SelectedAttachment | null;
  setAttachmentDraft: (update: SetStateAction<SelectedAttachment | null>) => void;
  selectAttachment: (file: File, type: FilePreview['type'], forceDocument: boolean) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextFileAsDocument = useRef(false);
  const forceAsDocument = selectedFile?.forceDocument ?? false;

  function chooseFile(file: File, forceDocument = false) {
    const error = validateFile(file);
    if (error) {
      window.alert(error);
      return;
    }
    selectAttachment(file, getFileType(file), forceDocument);
  }

  function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const force = nextFileAsDocument.current;
    nextFileAsDocument.current = false;
    event.target.value = '';
    if (file) chooseFile(file, force);
  }

  function handlePaste(event: ClipboardEvent) {
    for (const item of event.clipboardData.items) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      chooseFile(file);
      break;
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files?.[0];
    if (file) chooseFile(file);
  }

  const clearFile = useCallback((expected?: File) => {
    setAttachmentDraft((current) => expected && current?.file !== expected ? current : null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [setAttachmentDraft]);

  function toggleSendAsDocument() {
    setAttachmentDraft((current) => current ? { ...current, forceDocument: !current.forceDocument } : current);
  }

  function selectFileAsDocument(force: boolean) {
    nextFileAsDocument.current = force;
  }

  async function uploadLegacyFile(
    chatId: string,
    message: string,
    onSuccess: (messageId: string) => void,
    onError: (error: string) => void,
  ) {
    const file = selectedFile?.file;
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      if (message) form.set('message', message);
      form.set('forceDocument', String(forceAsDocument));
      form.set('file', file);
      const { data } = await api.post(`/chats/${encodeURIComponent(chatId)}/messages`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const messageId = data?.messageId ?? data?.data?.messageId ?? data?.id;
      if (data?.success !== true ||
          !(typeof messageId === 'string' && messageId || typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0)) {
        throw new Error('El servidor no confirmó el envío del archivo.');
      }
      clearFile(file);
      onSuccess(String(messageId));
    } catch (error) {
      const message = isAxiosError(error) && error.response ? getMediaErrorMessage(error)
        : error instanceof Error ? error.message : 'No se pudo enviar el archivo.';
      onError(message);
    } finally {
      setUploading(false);
    }
  }

  return {
    uploading, forceAsDocument, fileInputRef, handleFileSelect, handlePaste, handleDrop, clearFile,
    uploadLegacyFile, toggleSendAsDocument, selectFileAsDocument,
  };
}
