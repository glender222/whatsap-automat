// src/factures/mensajeria/components/bandeja de chats/MessageInputBar.tsx

import React, { useState, useRef, useEffect, useId } from 'react';
import {
  Paperclip,
  Smile,
  Send,
  Loader2,
  Image,
  FileText,
  FileVideo,
  MessageSquare, // ✅ Para respuestas rápidas
} from 'lucide-react';
import EmojiPicker from '../extras/EmojiPicker';
import FilePreviewCard from './FilePreviewCard';
import QuickReplies from './QuickReplies'; // ✅ NUEVO: Respuestas rápidas
import { useFileUpload } from '../../hooks/useFileUpload';
import type { RefObject } from 'react';

interface MessageInputBarProps {
  message: string;
  setMessage: (msg: string) => void;
  selectedChat: string | null;
  handleSendMessage: () => Promise<void> | void; // Solo para texto puro
  canSendText: boolean;
  canSendFile: boolean;
  textSending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  emojiPickerOpen: boolean;
  setEmojiPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  emojiPickerRef: RefObject<HTMLDivElement | null>;
  handleEmojiSelect: (emoji: string) => void;
  onOptimisticMessage?: (message: any) => void; // ✅ NUEVO: Callback para agregar mensaje optimista
  onMessageSent?: (tempId: string, realId: string) => void; // ✅ NUEVO: Callback cuando se confirma el envío
  onMessageError?: (tempId: string) => void; // ✅ NUEVO: Callback cuando falla el envío
}

const MessageInputBar: React.FC<MessageInputBarProps> = ({
  message,
  setMessage,
  selectedChat,
  handleSendMessage,
  canSendText,
  canSendFile,
  textSending,
  inputRef,
  emojiPickerOpen,
  setEmojiPickerOpen,
  emojiPickerRef,
  handleEmojiSelect,
  onOptimisticMessage,
  onMessageSent,
  onMessageError,
}) => {
  const {
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
  } = useFileUpload();

  const [dragActive, setDragActive] = useState(false);
  const [isAttachMenuOpen, setAttachMenuOpen] = useState(false);
  const [isQuickRepliesOpen, setQuickRepliesOpen] = useState(false); // ✅ NUEVO: Estado para respuestas rápidas
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const emojiPickerId = useId();
  const fileSendLock = useRef(false);
  const canSubmit = !uploading && !textSending && Boolean(selectedFile ? canSendFile : canSendText && message.trim());

  // ✅ NUEVO: Manejar envío combinado (archivo + caption)
  const handleCombinedSend = async () => {
    if (!selectedChat || !canSubmit) return;

    if (selectedFile) {
      if (fileSendLock.current) return;
      fileSendLock.current = true;
      // ✅ Crear mensaje optimista
      const tempId = `temp-file-${Date.now()}`;
      const optimisticMessage = {
        id: tempId,
        body: message || selectedFile.file.name,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        sender: selectedChat,
        chatId: selectedChat,
        type: selectedFile.type,
        filename: selectedFile.file.name,
        mimetype: selectedFile.file.type,
        mediaUrl: selectedFile.preview, // Preview local temporal
        isOptimistic: true,
        uploadProgress: 0,
      };

      // ✅ Mostrar mensaje inmediatamente
      onOptimisticMessage?.(optimisticMessage);

      // ✅ Limpiar input inmediatamente
      const caption = message;
      setMessage('');

      // ✅ ENVIAR ARCHIVO EN SEGUNDO PLANO
      try {
        await uploadFile(
          selectedChat,
          caption,
          (realMessageId: string) => onMessageSent?.(tempId, realMessageId),
          () => onMessageError?.(tempId),
        );
      } finally {
        fileSendLock.current = false;
      }
    } else if (message.trim()) {
      await handleSendMessage();
    }
  };

  // ✅ NUEVO: Enter con o sin archivo
  const handleKeyPressWithFile = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleCombinedSend();
    }
  };

  // Drag & Drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (canSendFile) setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const handleDropFile = (e: React.DragEvent) => {
    if (canSendFile) handleDrop(e);
    else e.preventDefault();
    setDragActive(false);
  };

  // --- ✅ INICIO: Lógica del nuevo menú desplegable ---

  // Manejador del botón principal de adjuntar
  const handleAttachClick = () => {
    setAttachMenuOpen((prev) => !prev);
  };

  // Abrir diálogo solo para "Fotos y videos"
  const openMediaDialog = () => {
    if (fileInputRef.current) {
      fileInputRef.current.accept =
        'image/*,video/mp4,video/mpeg,video/quicktime,video/x-msvideo,video/webm,audio/*';
      fileInputRef.current.click();
    }
    setAttachMenuOpen(false);
  };

  // Abrir diálogo solo para "Documentos"
  const openDocumentDialog = () => {
    if (fileInputRef.current) {
      fileInputRef.current.accept =
        '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar';
      fileInputRef.current.click();
    }
    setAttachMenuOpen(false);
  };

  // ✅ NUEVA FUNCIÓN: Abrir diálogo para videos como documento
  const openVideoAsDocumentDialog = () => {
    if (fileInputRef.current) {
      fileInputRef.current.accept =
        'video/mp4,video/mpeg,video/quicktime,video/x-msvideo,video/webm,video/mov,video/avi,video/mkv';
      selectFileAsDocument(); // ✅ Marcar que el próximo archivo debe ser documento
      fileInputRef.current.click();
    }
    setAttachMenuOpen(false);
  };

  // Efecto para cerrar el menú al hacer clic fuera
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        attachMenuRef.current &&
        !attachMenuRef.current.contains(event.target as Node)
      ) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // --- ✅ FIN: Lógica del nuevo menú desplegable ---

  return (
    <div
      className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-4 flex-shrink-0 relative"
      onDragEnter={handleDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDropFile}
    >
      {/* Overlay de drag & drop */}
      {dragActive && (
        <div className="absolute inset-0 bg-blue-500 dark:bg-blue-600 bg-opacity-10 dark:bg-opacity-20 border-2 border-dashed border-blue-500 dark:border-blue-400 rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <div className="text-blue-600 dark:text-blue-400 font-medium text-lg">
            Suelta aquí para adjuntar
          </div>
        </div>
      )}

      {/* ✅ NUEVO: Panel de Respuestas Rápidas */}
      <QuickReplies
        isOpen={isQuickRepliesOpen}
        onClose={() => setQuickRepliesOpen(false)}
        onSelectReply={(text) => setMessage(text)}
      />

      {/* Vista previa del archivo seleccionado */}
      {selectedFile && (
        <FilePreviewCard
          filePreview={selectedFile}
          forceAsDocument={forceAsDocument}
          onRemove={clearFile}
          onToggleSendMode={toggleSendAsDocument}
        />
      )}

      {/* Input oculto para seleccionar archivos (mantiene todos los tipos) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/mp4,video/mpeg,video/quicktime,video/x-msvideo,video/webm,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Barra de entrada */}
      <div className="flex items-end gap-3">
        {/* ✅ MODIFICADO: Botón adjuntar archivo (AHORA CON MENÚ) */}
        <div className="relative" ref={attachMenuRef}>
          <button
            onClick={handleAttachClick} // ✅ CAMBIADO
            disabled={uploading || !canSendFile}
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Adjuntar"
          >
            <Paperclip size={20} />
          </button>

          {/* ✅ NUEVO: Menú desplegable */}
          {isAttachMenuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-60 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-100 dark:border-gray-700 z-20 py-1 overflow-hidden">
              <button
                onClick={openMediaDialog}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <Image size={20} className="text-gray-500 dark:text-gray-400" />
                <span>Fotos y videos</span>
              </button>
              <button
                onClick={openVideoAsDocumentDialog}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <FileVideo size={20} className="text-purple-500 dark:text-purple-400" />
                <span>Video como documento</span>
              </button>
              <button
                onClick={openDocumentDialog}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <FileText size={20} className="text-gray-500 dark:text-gray-400" />
                <span>Documento</span>
              </button>
            </div>
          )}
        </div>

        {/* ✅ NUEVO: Botón respuestas rápidas */}
        <button
          onClick={() => setQuickRepliesOpen((prev) => !prev)}
          disabled={uploading || !selectedChat}
          className={`p-2 rounded-lg transition-colors ${isQuickRepliesOpen
            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          title="Respuestas rápidas"
        >
          <MessageSquare size={20} />
        </button>

        {/* Botón emoji picker */}
        <div className="contents" ref={emojiPickerRef}>
          <button
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            onClick={() => setEmojiPickerOpen((prev) => !prev)}
            type="button"
            aria-label="Emojis"
            aria-expanded={emojiPickerOpen}
            aria-haspopup="dialog"
            aria-controls={emojiPickerOpen ? emojiPickerId : undefined}
            disabled={uploading || !selectedChat}
          >
            <Smile size={20} />
          </button>
          <EmojiPicker
            id={emojiPickerId}
            open={emojiPickerOpen}
            onSelect={handleEmojiSelect}
          />
        </div>

        {/* Textarea con soporte Ctrl+V */}
        <div className="min-w-0 flex-1">
          <textarea
            ref={inputRef}
            aria-label="Mensaje"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyPressWithFile}
            onPaste={canSendFile ? handlePaste : undefined}
            placeholder={
              selectedFile
                ? 'Comentario del archivo (opcional)'
                : 'Escribe un mensaje'
            }
            className="w-full px-4 py-2 border border-gray-200 dark:border-gray-600 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
            rows={1}
            style={{ maxHeight: '120px' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 120) + 'px';
            }}
            disabled={uploading || !selectedChat}
          />
        </div>

        {/* Botón enviar */}
        <button
          type="button"
          aria-label={selectedFile ? 'Enviar archivo' : 'Enviar mensaje'}
          onClick={handleCombinedSend}
          disabled={!canSubmit}
          className={`p-2 rounded-lg transition-colors min-w-[40px] flex items-center justify-center ${canSubmit
            ? 'bg-green-500 dark:bg-green-600 text-white hover:bg-green-600 dark:hover:bg-green-700'
            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
            }`}
        >
          {uploading || textSending ? (
            <Loader2 size={20} className="animate-spin" />
          ) : (
            <Send size={20} />
          )}
        </button>
      </div>

      {/* Indicador de carga */}
      {uploading && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          Enviando archivo...
        </div>
      )}

    </div>
  );
};

export default MessageInputBar;
