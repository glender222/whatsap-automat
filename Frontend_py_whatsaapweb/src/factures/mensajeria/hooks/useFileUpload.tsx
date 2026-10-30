// src/factures/mensajeria/hooks/useFileUpload.tsx

import { useState, useRef, useCallback } from 'react';
import { api } from '../../../shared/axios/http'; // Usar cliente compartido con token
import type { FilePreview } from '../../../shared/types/wsp';
import { getMediaErrorMessage } from '../services/mediaService';

export function useFileUpload() {
  const [selectedFile, setSelectedFile] = useState<FilePreview | null>(null);
  const [uploading, setUploading] = useState(false);
  const [forceAsDocument, setForceAsDocument] = useState(false); // ✅ NUEVO: Forzar como documento
  const [nextFileAsDocument, setNextFileAsDocument] = useState(false); // ✅ NUEVO: Marcar próximo archivo como documento
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Determinar el tipo de archivo
  const getFileType = (file: File): FilePreview['type'] => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'document';
  };

  // TODO  Validar archivo de glender
const validateFile = (file: File): string | null => {
  const maxSize = 100 * 1024 * 1024; 
  if (file.size > maxSize) {
    return 'El archivo es demasiado grande (máximo 100MB)';
  }
  
  // ✅ VALIDACIONES MÁS FLEXIBLES PARA VIDEOS
  const validVideoTypes = [
    'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 
    'video/webm', 'video/3gpp', 'video/mov', 'video/avi', 'video/mkv',
    'video/x-ms-wmv', 'video/x-flv'
  ];
  const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
  const validAudioTypes = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp3', 'audio/aac'];
  
  // ✅ PERMITIR TODOS LOS VIDEOS - Si no está en la lista, lo enviamos como documento
  if (file.type.startsWith('video/') && !validVideoTypes.includes(file.type)) {
    console.log(`⚠️ Video de tipo ${file.type} no reconocido, se enviará como documento`);
    // NO retornar error, simplemente se enviará como documento
  }

  if (file.type.startsWith('image/') && !validImageTypes.includes(file.type)) {
    return 'Formato de imagen no soportado. Usa JPEG, PNG, GIF, WEBP o BMP';
  }

  if (file.type.startsWith('audio/') && !validAudioTypes.includes(file.type)) {
    return 'Formato de audio no soportado. Usa MP3, OGG, WAV o AAC';
  }
  
  return null;
};

  // Seleccionar archivo desde input
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const error = validateFile(file);
    if (error) {
      alert(error);
      return;
    }

    const preview = URL.createObjectURL(file);
    const type = getFileType(file);

    setSelectedFile({ file, preview, type });

    // ✅ NUEVO: Si se marcó el próximo archivo como documento, aplicar esa configuración
    if (nextFileAsDocument) {
      setForceAsDocument(true);
      setNextFileAsDocument(false); // Resetear para próxima selección
    }
  }, [nextFileAsDocument]);

  // Pegar archivo desde portapapeles (Ctrl+V)
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);

    for (const item of items) {
      // Solo procesar imágenes pegadas
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const error = validateFile(file);
        if (error) {
          alert(error);
          continue;
        }

        const preview = URL.createObjectURL(file);
        setSelectedFile({
          file,
          preview,
          type: 'image'
        });
        break;
      }
    }
  }, []);

  // Arrastrar y soltar (Drag & Drop)
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const error = validateFile(file);
    if (error) {
      alert(error);
      return;
    }

    const preview = URL.createObjectURL(file);
    const type = getFileType(file);

    setSelectedFile({ file, preview, type });
  }, []);

  // Cancelar selección
  const clearFile = useCallback(() => {
    if (selectedFile?.preview) {
      URL.revokeObjectURL(selectedFile.preview);
    }
    setSelectedFile(null);
    setForceAsDocument(false); // ✅ Resetear también el estado de documento
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [selectedFile]);

  // ✅ NUEVA FUNCIÓN: Alternar modo de envío (media vs documento)
  const toggleSendAsDocument = useCallback(() => {
    setForceAsDocument(prev => !prev);
  }, []);

  // ✅ NUEVA FUNCIÓN: Marcar el próximo archivo a seleccionar como documento
  const selectFileAsDocument = useCallback(() => {
    setNextFileAsDocument(true);
  }, []);

  // Enviar archivo
  const uploadFile = useCallback(async (
    chatId: string,
    message: string,
    onSuccess?: (messageId: string) => void,
    onError?: (error: string) => void
  ) => {
    if (!selectedFile) return;
    setUploading(true);
    
    try {
      const file = selectedFile.file;
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      
      console.log('📁 Enviando archivo:', {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        isImage,
        isVideo,
        chatId
      });

      console.log('🔍 DEBUG - selectedFile:', selectedFile);
      console.log('🔍 DEBUG - file object:', file);
      console.log('🔍 DEBUG - file instanceof File:', file instanceof File);

      const formData = new FormData();
      // ✅ CORREGIDO: NO enviar chatId en FormData, va en la URL
      if (message) formData.append('message', message);
      formData.append('forceDocument', String(forceAsDocument));
      
      // ✅ ASEGURAR que el archivo se agregue correctamente
      if (file && file instanceof File) {
        formData.append('file', file, file.name);
        console.log('✅ Archivo agregado al FormData:', file.name);
      } else {
        console.error('❌ ERROR: file no es una instancia de File', file);
      }

      // ✅ DEBUG: Verificar contenido del FormData
      console.log('📦 FormData contenido:');
      for (const [key, value] of formData.entries()) {
        console.log(`  - ${key}:`, value instanceof File ? `File(${value.name}, ${value.size} bytes)` : value);
      }

      // ✅ CORREGIDO: Endpoint unificado del backend
      const endpoint = `/chats/${encodeURIComponent(chatId)}/messages`;

      if (forceAsDocument) {
        console.log('📄 Enviando como DOCUMENTO (forzado por usuario)');
      } else if (isImage || isVideo) {
        console.log('📹 Enviando como MEDIA (reproducible)');
      } else {
        console.log('📄 Enviando como DOCUMENTO (descargable)');
      }

      console.log(`🚀 Enviando POST a: ${endpoint}`);
      
      // ✅ CORREGIDO: Configuración correcta para multipart/form-data
      const response = await api.post(endpoint, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        transformRequest: [(data) => data], // ✅ NO transformar el FormData
      });

      console.log('✅ Archivo enviado exitosamente:', response.data);
      
      clearFile();
      setUploading(false);
      
      // ✅ Devolver el ID del mensaje creado
      const messageId = response.data?.messageId || response.data?.data?.messageId || response.data?.id || `msg-${Date.now()}`;
      if (onSuccess) onSuccess(messageId);
      return response.data;
      
    } catch (error: any) {
      setUploading(false);
      console.error('❌ Error enviando archivo:', error);
      
      let errorMessage = 'Error desconocido';
      if (error.response) {
        const { status, data } = error.response;
        console.error('📊 Detalles del error:', { status, data });
        errorMessage = getMediaErrorMessage(error);
      } else if (error.request) {
        errorMessage = 'Error de conexión con el servidor';
      } else {
        errorMessage = error.message || 'Error desconocido';
      }
      
      if (onError) {
        onError(errorMessage);
      } else {
        console.error('Error uploading file:', error);
        alert(`Error al enviar archivo: ${errorMessage}`);
      }
    }
  }, [selectedFile, clearFile, forceAsDocument]);

  return {
    selectedFile,
    uploading,
    forceAsDocument,
    fileInputRef,
    handleFileSelect,
    handlePaste,
    handleDrop,
    clearFile,
    uploadFile,
    toggleSendAsDocument,
    selectFileAsDocument,
    openFileDialog: () => fileInputRef.current?.click(),
  };
}
