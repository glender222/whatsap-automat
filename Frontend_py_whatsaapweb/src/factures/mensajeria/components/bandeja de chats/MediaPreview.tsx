import React, { useEffect, useState } from 'react';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';
import { Download, FileImage, FileVideo, FileAudio, FileText, Play, Loader2 } from 'lucide-react';
import AudioMessage from '../extras/AudioMessage';
import { copyImageToClipboard, getAuthenticatedMediaObjectUrl } from '../../services/mediaService';




interface MediaPreviewProps {
  msg: WhatsAppMessage;
  getMediaBlob?: (id: string) => Promise<string | undefined>;
}

const getFileIcon = (type?: string, mimetype?: string | null) => {
  if (type === "image") return <FileImage size={24} className="text-blue-500" />;
  if (type === "audio") return <FileAudio size={24} className="text-green-500" />;
  if (type === "video") return <FileVideo size={24} className="text-purple-500" />;
  if (mimetype === "application/pdf") return <FileText size={24} className="text-red-500" />;
  return <FileText size={24} className="text-gray-500" />;
};

const MediaPreview: React.FC<MediaPreviewProps> = ({ msg, getMediaBlob }) => {
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [publicMediaUrl, setPublicMediaUrl] = useState<string | undefined>();
  const objectUrlRef = React.useRef<string | undefined>(undefined);

  const originalUrl = msg.mediaUrl || undefined;
  const filename = msg.filename || "Archivo sin nombre";

  // Para todos los medias: obtener la URL pública del backend
  useEffect(() => {
    let cancel = false;
    
    // Verificar si msg.mediaUrl es un endpoint API o una URL pública
    const isApiEndpoint = msg.mediaUrl && (
      msg.mediaUrl.startsWith('/api/media/') || 
      msg.mediaUrl.includes('/api/media/')
    );

    console.log('[MediaPreview] Media Debug:', {
      messageId: msg.id,
      type: msg.type,
      mediaUrl: msg.mediaUrl,
      isApiEndpoint,
      mimetype: msg.mimetype
    });

    if (isApiEndpoint && msg.id) {
      setLoading(true);
      getAuthenticatedMediaObjectUrl(msg.mediaUrl || msg.id).then((objectUrl) => {
        if (!cancel) {
          if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = objectUrl;
          setPublicMediaUrl(objectUrl);
          if (msg.type === 'video' || msg.type === 'image') {
            setPreviewUrl(objectUrl);
          }
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      }).catch(err => {
        console.error('[MediaPreview] Error obteniendo media autenticada:', err);
      }).finally(() => {
        if (!cancel) setLoading(false);
      });
    } else if (msg.mediaUrl) {
      // Ya es una URL pública (comienza con /uploads o es completa)
      console.log('[MediaPreview] Usando URL directa:', originalUrl);
      setPublicMediaUrl(originalUrl);
      if (msg.type === 'video' || msg.type === 'image') {
        setPreviewUrl(originalUrl);
      }
    }
    
    return () => {
      cancel = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };
  }, [msg.id, msg.mediaUrl, msg.type, originalUrl]);

  // Si el usuario igual quiere forzar una descarga, esto sigue funcionando
  const handleDownload = async () => {
    if (previewUrl) {
      window.open(previewUrl, '_blank');
      return;
    }
    if (!getMediaBlob || !msg.id) return;
    setLoading(true);
    try {
      const blobUrl = await getMediaBlob(msg.id);
      setPreviewUrl(blobUrl || originalUrl);
      window.open(blobUrl || originalUrl, '_blank');
    } catch (error) {
      console.error('Error loading media:', error);
    } finally {
      setLoading(false);
    }
  };

  // === IMAGEN ===
  if (msg.type === "image") {
    return (
      <div className="relative mb-2 rounded-lg overflow-hidden max-w-xs group bg-gray-100">
        {previewUrl ? (
          <>
          <img
            src={previewUrl}
            alt={filename}
            className="w-full h-auto max-h-96 object-contain rounded-lg"
          />
          {/* Botón copiar (aparece al hacer hover) */}
          <button
            onClick={() => copyImageToClipboard(previewUrl)}
            className="absolute top-2 right-2 bg-black bg-opacity-50 text-white p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            title="Copiar imagen (Ctrl+C)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </>



        ) : originalUrl ? (
          <>
            <img
              src={originalUrl}
              alt="Vista previa"
              className="w-full h-48 object-cover blur-md brightness-90"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30 backdrop-blur-sm">
              <button
                onClick={handleDownload}
                disabled={loading}
                className="flex flex-col items-center gap-2 text-white hover:scale-110 transition-transform"
                aria-label="Ver imagen completa"
              >
                {loading ? (
                  <Loader2 size={48} className="animate-spin" />
                ) : (
                  <>
                    <div className="bg-white/20 backdrop-blur-md rounded-full p-4">
                      <Download size={32} />
                    </div>
                    <span className="text-sm font-medium">Toca para ver</span>
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="w-full h-48 flex items-center justify-center bg-gray-200">
            <FileImage size={64} className="text-gray-400" />
          </div>
        )}
      </div>
    );
  }

  // === VIDEO ===
  if (msg.type === "video") {
    return (
      <div className="relative mb-2 rounded-lg overflow-hidden max-w-xs bg-black">
        {previewUrl ? (
          <video
            controls
            className="w-full h-auto max-h-96 rounded-lg"
            controlsList="nodownload"
          >
            {/* ✅ Usar múltiples fuentes para mejor compatibilidad */}
            <source src={previewUrl} type={msg.mimetype || 'video/mp4'} />
            <source src={previewUrl} type="video/mp4" />
            <source src={previewUrl} type="video/webm" />
            Tu navegador no soporta la reproducción de video.
          </video>
        ) : (
          <div className="relative w-full h-48 bg-gradient-to-br from-purple-900 to-purple-700">
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <button
                onClick={handleDownload}
                disabled={loading}
                className="flex flex-col items-center gap-3 text-white hover:scale-105 transition-transform"
                aria-label="Cargar video"
              >
                {loading ? (
                  <>
                    <Loader2 size={56} className="animate-spin" />
                    <span className="text-sm">Cargando video...</span>
                  </>
                ) : (
                  <>
                    <div className="bg-white/20 backdrop-blur-md rounded-full p-5">
                      <Play size={36} className="ml-1" />
                    </div>
                    <span className="text-sm font-medium">Reproducir video</span>
                  </>
                )}
              </button>
            </div>
            <div className="absolute top-3 left-3">
              <FileVideo size={24} className="text-white/80" />
            </div>
          </div>
        )}
      </div>
    );
  }

  // === AUDIO ===
  if (msg.type === "audio") {
    return (
      <div className="mb-2 max-w-xs">
        {previewUrl ? (
          <AudioMessage url={previewUrl} />
        ) : (
          <button
            onClick={handleDownload}
            disabled={loading}
            className="flex items-center gap-3 bg-gradient-to-r from-green-50 to-emerald-50 hover:from-green-100 hover:to-emerald-100 border border-green-200 rounded-full px-4 py-3 transition-all shadow-sm hover:shadow w-full"
            aria-label="Cargar mensaje de audio"
          >
            <div className="bg-green-500 rounded-full p-2">
              {loading ? (
                <Loader2 size={20} className="text-white animate-spin" />
              ) : (
                <FileAudio size={20} className="text-white" />
              )}
            </div>
            <div className="flex-1 text-left">
              <div className="text-sm font-medium text-gray-800">
                {loading ? 'Cargando audio...' : 'Mensaje de voz'}
              </div>
              <div className="text-xs text-gray-500">
                Toca para escuchar
              </div>
            </div>
            {!loading && (
              <Play size={20} className="text-green-600" />
            )}
          </button>
        )}
      </div>
    );
  }

  // === PDF ===
  if (msg.mimetype === "application/pdf") {
    // Usar la URL pública obtenida del backend (no el endpoint API)
    const pdfUrl = publicMediaUrl;

    return (
      <div className="mb-2 max-w-xs">
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-3 hover:bg-red-100 transition-colors">
          <div className="bg-red-500 rounded-lg p-2 flex-shrink-0">
            <FileText size={24} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800 truncate mb-1">
              {filename}
            </div>
            <div className="text-xs text-gray-500 mb-2">Documento PDF</div>
            {pdfUrl ? (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700"
              >
                <Download size={14} />
                Abrir documento
              </a>
            ) : loading ? (
              <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                <Loader2 size={14} className="animate-spin" />
                Cargando...
              </span>
            ) : (
              <span className="text-xs text-gray-400">URL no disponible</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // === DOCUMENTOS GENERALES ===
  if (msg.type === "document" || msg.mediaUrl) {
    const fileExt = filename.split('.').pop()?.toUpperCase() || 'FILE';

    return (
      <div className="mb-2 max-w-xs">
        <div className="flex items-start gap-3 bg-gray-50 border border-gray-200 rounded-lg p-3 hover:bg-gray-100 transition-colors">
          <div className="bg-gray-500 rounded-lg p-2 flex-shrink-0">
            {getFileIcon(msg.type, msg.mimetype)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800 truncate mb-1">
              {filename}
            </div>
            <div className="text-xs text-gray-500 mb-2">
              Archivo {fileExt}
            </div>
            <button
              onClick={handleDownload}
              disabled={loading}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
            >
              {loading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Descargando...
                </>
              ) : (
                <>
                  <Download size={14} />
                  Descargar archivo
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default MediaPreview;
