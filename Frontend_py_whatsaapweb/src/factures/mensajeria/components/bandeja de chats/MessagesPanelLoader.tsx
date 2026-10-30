
import React, { useEffect, useState, useCallback } from 'react';
import type { RefObject } from 'react';
import { CheckCheck, Download, FileText, FileAudio2, FileVideo, FileImage, FileSpreadsheet, FileArchive, FileBadge, FileQuestion } from 'lucide-react';
import AudioMessage from '../extras/AudioMessage';
import { useIndexedMessages } from '../../hooks/useIndexedMessages';
import { useMediaQueue } from '../../hooks/useMediaQueue';
import { getMediaUrl as buildMediaUrl } from '../../../../shared/utils/urls';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';

interface MessagesPanelProps {
  selectedChat: string | null;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

const getFileIcon = (msg: WhatsAppMessage) => {
  if (msg.type === "image") return <FileImage size={32} className="text-gray-400" />;
  if (msg.type === "audio") return <FileAudio2 size={32} className="text-gray-400" />;
  if (msg.type === "video") return <FileVideo size={32} className="text-gray-400" />;
  if (msg.mimetype?.includes('pdf')) return <FileText size={32} className="text-red-400" />;
  if (msg.mimetype?.includes('msword') || msg.filename?.endsWith('.doc') || msg.filename?.endsWith('.docx')) return <FileText size={32} className="text-blue-500" />;
  if (msg.mimetype?.includes('spreadsheet') || msg.filename?.endsWith('.xls') || msg.filename?.endsWith('.xlsx')) return <FileSpreadsheet size={32} className="text-green-500" />;
  if (msg.mimetype?.includes('presentation') || msg.filename?.endsWith('.ppt') || msg.filename?.endsWith('.pptx')) return <FileText size={32} className="text-orange-500" />;
  if (msg.mimetype?.includes('zip') || msg.filename?.endsWith('.zip') || msg.filename?.endsWith('.rar')) return <FileArchive size={32} className="text-yellow-500" />;
  if (msg.mimetype?.includes('sticker')) return <FileBadge size={32} className="text-purple-500" />;
  return <FileQuestion size={32} className="text-gray-400" />;
};

const MessagesPanel: React.FC<MessagesPanelProps> = ({
  selectedChat,
  messagesEndRef,
}) => {
  const [serviceDone, setServiceDone] = useState(false);

  // Hook para obtener y cachear mensajes y media
  const { messages, loading } = useIndexedMessages(selectedChat ?? '');
  // Hook para gestionar la cola de descargas de media
  const { enqueue, getMediaUrl } = useMediaQueue();

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, selectedChat, messagesEndRef]);

  // Renderiza la vista previa del media según tipo, usando la cola de descargas
  const renderMedia = useCallback((msg: WhatsAppMessage) => {
    const filename = msg.filename || "Archivo";
    // Estado local para la url descargada
    const [mediaUrl, setMediaUrl] = useState<string | undefined>(getMediaUrl(msg.id));
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
      if (!mediaUrl && msg.mediaUrl && !downloading) {
        setDownloading(true);
        enqueue(msg.id, (url, err) => {
          setDownloading(false);
          if (url) setMediaUrl(url);
          if (err) setError('Error al descargar archivo');
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [msg.id]);

    // PDF
    if (msg.mimetype === "application/pdf" && msg.mediaUrl) {
      return (
        <div className="mb-1 flex items-center gap-3">
          {getFileIcon(msg)}
          <div>
            <div className="font-medium text-gray-700">{filename}</div>
            {mediaUrl ? (
              <a href={mediaUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center text-blue-600 underline mt-1"
                aria-label="Abrir o descargar PDF"
              >
                <Download size={18} className="mr-1" /> Abrir / Descargar
              </a>
            ) : downloading ? (
              <div className="text-xs text-gray-400">Obteniendo URL...</div>
            ) : error ? (
              <div className="text-xs text-red-500">{error}</div>
            ) : (
              <div className="text-xs text-gray-400">Procesando...</div>
            )}
          </div>
        </div>
      );
    }

    // Word, Excel, PowerPoint, otros docs
    if ((msg.mimetype?.includes('msword') || msg.filename?.endsWith('.doc') || msg.filename?.endsWith('.docx') ||
         msg.mimetype?.includes('spreadsheet') || msg.filename?.endsWith('.xls') || msg.filename?.endsWith('.xlsx') ||
         msg.mimetype?.includes('presentation') || msg.filename?.endsWith('.ppt') || msg.filename?.endsWith('.pptx') ||
         msg.mimetype?.includes('zip') || msg.filename?.endsWith('.zip') || msg.filename?.endsWith('.rar')) && msg.mediaUrl) {
      return (
        <div className="mb-1 flex items-center gap-3">
          {getFileIcon(msg)}
          <div>
            <div className="font-medium text-gray-700">{filename}</div>
            <button
              onClick={() => {
                if (!mediaUrl && !downloading) {
                  setDownloading(true);
                  enqueue(msg.id, (url, err) => {
                    setDownloading(false);
                    if (url) setMediaUrl(url);
                    if (err) setError('Error al descargar archivo');
                  });
                } else if (mediaUrl) {
                  window.open(mediaUrl, '_blank');
                }
              }}
              className="flex items-center bg-gray-200 hover:bg-gray-300 rounded px-2 py-1 mt-1 transition"
              aria-label="Abrir o descargar documento"
            >
              <Download size={18} className="mr-1" /> Abrir / Descargar
            </button>
            {downloading && <div className="text-xs text-gray-400">Descargando...</div>}
            {error && <div className="text-xs text-red-500">{error}</div>}
          </div>
        </div>
      );
    }

    // Sticker
    if (msg.mimetype?.includes('sticker') && msg.mediaUrl) {
      return (
        <img
          src={mediaUrl || buildMediaUrl(msg.mediaUrl || '')}
          alt={filename}
          className="max-w-[120px] rounded-lg mb-1"
          style={{ display: 'inline-block' }}
        />
      );
    }

    // Imágenes
    if (msg.type === "image" && msg.mediaUrl) {
      return (
        <img
          src={mediaUrl || buildMediaUrl(msg.mediaUrl || '')}
          alt={filename}
          className="max-w-[180px] rounded-lg mb-1"
          style={{ display: 'inline-block' }}
        />
      );
    }

    // Video
    if (msg.type === "video" && msg.mediaUrl) {
      return (
        <video
          src={mediaUrl || buildMediaUrl(msg.mediaUrl || '')}
          controls
          className="max-w-[180px] rounded-lg mb-1"
          style={{ display: 'inline-block' }}
        >
          Tu navegador no soporta el vídeo.
        </video>
      );
    }

    // Audio
    if (msg.type === "audio" && msg.mediaUrl) {
      return (
        <AudioMessage
          url={mediaUrl || buildMediaUrl(msg.mediaUrl || '')}
          unreadCount={msg.unreadCount}
        />
      );
    }

    // Otros documentos
    if (msg.type === "document" && msg.mediaUrl) {
      return (
        <div className="flex items-center gap-3 mb-1">
          {getFileIcon(msg)}
          <div>
            <div className="font-medium text-gray-700">{filename}</div>
            <button
              onClick={() => {
                if (!mediaUrl && !downloading) {
                  setDownloading(true);
                  enqueue(msg.id, (url, err) => {
                    setDownloading(false);
                    if (url) setMediaUrl(url);
                    if (err) setError('Error al descargar archivo');
                  });
                } else if (mediaUrl) {
                  window.open(mediaUrl, '_blank');
                }
              }}
              className="flex items-center bg-gray-200 hover:bg-gray-300 rounded px-2 py-1 mt-1 transition"
              aria-label="Abrir o descargar documento"
            >
              <Download size={18} className="mr-1" /> Abrir / Descargar
            </button>
            {downloading && <div className="text-xs text-gray-400">Descargando...</div>}
            {error && <div className="text-xs text-red-500">{error}</div>}
          </div>
        </div>
      );
    }

    return null;
  }, [enqueue, getMediaUrl]);

  return (
    <div className="relative flex-1 overflow-y-auto px-4 py-3 min-h-0" style={{ overflowX: 'hidden' }}>
      {/* Barra superior sticky con botones */}
      <div
        className="sticky top-0 w-full flex justify-between items-center z-30 bg-transparent"
        style={{ height: 44 }}
      >
        <div className="m-2" />
        {/* Botón Servicio Realizado */}
        <div className="m-2">
          <button
            className="shadow rounded flex items-center justify-center transition-colors"
            style={{
              width: 40,
              height: 40,
              backgroundColor: serviceDone ? '#a7f3d0' : '#e5e7eb',
            }}
            aria-label="Servicio realizado"
            onClick={() => setServiceDone((done) => !done)}
          >
            <CheckCheck
              size={28}
              className={serviceDone ? "text-green-700" : "text-black"}
            />
          </button>
        </div>
      </div>
      {/* Mensajes */}
      {selectedChat ? (
        loading ? (
          <div className="text-center text-gray-400 pt-10">Cargando mensajes...</div>
        ) : (
          <div>
            {messages.length === 0 ? (
              <div className="text-center text-gray-400 pt-10">No hay mensajes en este chat</div>
            ) : (
              <>
                {messages.map(msg => (
                  <div key={msg.id} className={`mb-2 flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`rounded-xl px-3 py-2 max-w-xs ${msg.fromMe ? 'bg-green-100 text-right' : 'bg-white text-left'} shadow break-words`}
                      style={{
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        whiteSpace: 'pre-line',
                        minWidth: 0,
                      }}
                    >
                      {renderMedia(msg)}
                      {msg.body && (
                        <div className="text-sm text-gray-800 mb-1">{msg.body}</div>
                      )}
                      <div className="text-xs text-gray-400 mt-1">{new Date(msg.timestamp * 1000).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        )
      ) : (
        <div className="text-center text-gray-500">
          <div className="mb-4">
            <div className="w-20 h-20 bg-gray-200 rounded-full mx-auto flex items-center justify-center">
              <span className="text-3xl text-gray-400">💬</span>
            </div>
          </div>
          <h3 className="text-lg font-medium text-gray-700 mb-2">Selecciona un chat</h3>
          <p className="text-sm">Elige una conversación para comenzar a chatear</p>
        </div>
      )}
    </div>
  );
};

export default MessagesPanel;
