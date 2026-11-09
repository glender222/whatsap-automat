import React, { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { CheckCheck, ChevronDown, ChevronRight, TerminalSquare } from 'lucide-react';
import ChatFilePreview from './ChatFilePreview';
import AudioMessage from '../extras/AudioMessage';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';
import FilePreview from '../../../../shared/components/FilePreview'; 
import { getAuthenticatedMediaBlob, getAuthenticatedMediaObjectUrl } from '../../services/mediaService';
import { getSessionStatus, completeSession } from '../../services/sessionService';
import { deliveryLabel } from '../../services/canonicalConversationApi';
import type { AgentActivityTurn } from '../../../agentes/services/agentService';

// Componente para modal de preview de documentos con obtención de URL pública
const DocumentPreviewModal: React.FC<{
  doc: WhatsAppMessage;
  onClose: () => void;
}> = ({ doc, onClose }) => {
  const [publicUrl, setPublicUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const objectUrlRef = React.useRef<string>('');

  const hasMediaObject = doc.hasMedia && doc.media;
  const mediaUrl = hasMediaObject ? doc.media!.mediaUrl : doc.mediaUrl;
  const mimetype = hasMediaObject ? doc.media!.mimetype : doc.mimetype;
  const filename = hasMediaObject ? doc.media!.filename : doc.filename;

  // Función para forzar descarga del archivo
  const handleDownload = async () => {
    if (!publicUrl) return;
    
    setDownloading(true);
    try {
      const blob = await getAuthenticatedMediaBlob(publicUrl);
      
      // Crear un link temporal y hacer clic para descargar
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'documento';
      document.body.appendChild(a);
      a.click();
      
      // Limpiar
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error descargando archivo:', error);
      alert('Error al descargar el archivo');
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    const loadPublicUrl = async () => {
      try {
        // ✅ Si es un mensaje optimista (aún subiendo), usar preview local
        if (doc.isOptimistic && mediaUrl) {
          setPublicUrl(mediaUrl); // mediaUrl es el blob:// local
          setLoading(false);
          return;
        }

        // Verificar si es un endpoint API
        const isApiEndpoint = mediaUrl && (
          mediaUrl.startsWith('/api/media/') || 
          mediaUrl.includes('/api/media/')
        );

        if (isApiEndpoint && doc.id) {
          const objectUrl = await getAuthenticatedMediaObjectUrl(mediaUrl || doc.id);
          if (mounted) {
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = objectUrl;
            setPublicUrl(objectUrl);
          } else {
            URL.revokeObjectURL(objectUrl);
          }
        } else if (mediaUrl) {
          setPublicUrl(mediaUrl);
        }
      } catch (error) {
        console.error('Error obteniendo URL pública:', error);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadPublicUrl();

    return () => {
      mounted = false;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
    };
  }, [doc.id, doc.isOptimistic, mediaUrl]);

  return (
    <div className="fixed inset-0 bg-black dark:bg-black bg-opacity-40 dark:bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 max-w-3xl w-full max-h-[90vh] overflow-auto relative">
        
        {/* Botón Cerrar */}
        <button
          className="absolute top-2 right-2 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 text-2xl font-bold z-10"
          onClick={onClose}
          aria-label="Cerrar vista previa"
        >
          ×
        </button>
        
        {/* Botón Descargar */}
        {publicUrl && (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="absolute top-2 left-3 px-3 py-1 bg-blue-500 dark:bg-blue-600 text-white rounded text-sm hover:bg-blue-600 dark:hover:bg-blue-700 z-10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {downloading ? 'Descargando...' : 'Descargar'}
          </button>
        )}

        {/* Título del archivo */}
        <h3 className="text-lg font-semibold mb-2 text-center pt-1 px-16 truncate text-gray-900 dark:text-gray-100">
          {filename}
        </h3>

        {/* Contenedor del preview */}
        <div className="max-h-[75vh] overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 dark:border-blue-400"></div>
              <span className="ml-3 text-gray-600 dark:text-gray-300">Cargando documento...</span>
            </div>
          ) : publicUrl ? (
            <FilePreview
              url={publicUrl}
              mimeType={mimetype ?? ''}
              fileName={filename ?? ''}
            />
          ) : (
            <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
              No se pudo cargar el documento
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Componente wrapper para manejar la carga de URL de audio
const AudioMessageWrapper: React.FC<{ mediaUrl: string; messageId: string }> = ({ mediaUrl, messageId }) => {
  const [audioUrl, setAudioUrl] = useState<string>('');
  const objectUrlRef = React.useRef<string>('');

  useEffect(() => {
    let mounted = true;
    
    const loadAudioUrl = async () => {
      try {
        // Verificar si es un endpoint API
        const isApiEndpoint = mediaUrl && (
          mediaUrl.startsWith('/api/media/') || 
          mediaUrl.includes('/api/media/')
        );

        if (isApiEndpoint) {
          const objectUrl = await getAuthenticatedMediaObjectUrl(mediaUrl || messageId);
          if (mounted) {
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = objectUrl;
            setAudioUrl(objectUrl);
          } else {
            URL.revokeObjectURL(objectUrl);
          }
        } else {
          if (mounted) {
            setAudioUrl(mediaUrl);
          }
        }
      } catch (error) {
        console.warn('Error loading audio URL:', error);
        if (mounted) {
          setAudioUrl(mediaUrl);
        }
      }
    };

    loadAudioUrl();

    return () => {
      mounted = false;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
    };
  }, [mediaUrl, messageId]);

  if (!audioUrl) {
    return (
      <div className="flex items-center bg-white dark:bg-gray-700 rounded-xl shadow px-3 py-2 mb-2" style={{ minWidth: 280 }}>
        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500 dark:border-gray-300 mr-2"></div>
        <span className="text-xs text-gray-500 dark:text-gray-400">Cargando audio...</span>
      </div>
    );
  }

  return <AudioMessage url={audioUrl} />;
};

interface MessagesPanelProps {
  selectedChat: string | null;
  loadingMessages: boolean;
  messages: WhatsAppMessage[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onImageClick?: (msg: WhatsAppMessage) => void; 
  onServiceCompleted?: () => void;
  agentActivity?: AgentActivityTurn[];
}

const AgentActivityRow: React.FC<{ turn: AgentActivityTurn }> = ({ turn }) => {
  const [expanded, setExpanded] = useState(false);
  const statusClass = turn.status === 'failed'
    ? 'text-red-700 dark:text-red-300'
    : turn.status === 'running'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-emerald-700 dark:text-emerald-300';

  return (
    <div className="mb-2 flex justify-center">
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-xs shadow-sm dark:border-slate-700 dark:bg-slate-900/80">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-700 dark:text-slate-200">
            <TerminalSquare className="h-4 w-4 flex-shrink-0 text-emerald-600" />
            <span className="truncate">Se ejecutaron {turn.commandCount} comandos</span>
          </span>
          <span className="flex flex-shrink-0 items-center gap-2">
            <span className={statusClass}>{turn.status}</span>
            <span className="text-slate-400">{new Date(turn.startedAt).toLocaleTimeString()}</span>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        </button>
        <div className="mt-1 text-slate-500 dark:text-slate-400">
          {turn.agentName || 'Agente IA'} · accion final: {turn.finalAction}
        </div>
        {expanded && (
          <div className="mt-2 space-y-2 border-t border-slate-100 pt-2 dark:border-slate-800">
            {turn.commands.length === 0 ? (
              <div className="text-slate-400">Sin comandos registrados para este turno.</div>
            ) : (
              turn.commands.map((command) => (
                <div key={command.id} className="rounded-md bg-slate-50 p-2 dark:bg-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-slate-700 dark:text-slate-200">
                    <span>{command.title || `Se ejecuto ${command.toolName || 'tool'}`}</span>
                    <span className={command.status === 'failed' ? 'text-red-600' : 'text-emerald-600'}>
                      {command.status}{command.durationMs !== null ? ` · ${command.durationMs}ms` : ''}
                    </span>
                  </div>
                  {command.summary && <div className="mt-1 text-slate-500 dark:text-slate-400">{command.summary}</div>}
                  <div className="mt-1 grid gap-2 md:grid-cols-2">
                    <pre className="max-h-28 overflow-auto rounded bg-white p-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(command.input || {}, null, 2)}
                    </pre>
                    <pre className="max-h-28 overflow-auto rounded bg-white p-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(command.output || {}, null, 2)}
                    </pre>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};

type TimelineItem =
  | { type: 'message'; timestamp: number; messageItem: WhatsAppMessage }
  | { type: 'activity'; timestamp: number; turn: AgentActivityTurn };

function messageTimestampMs(message: WhatsAppMessage): number {
  const timestamp = Number(message.timestamp || 0);
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function activityTimestampMs(turn: AgentActivityTurn): number {
  return new Date(turn.startedAt).getTime() || 0;
}

function buildTimeline(messages: WhatsAppMessage[], activity: AgentActivityTurn[]): TimelineItem[] {
  const orderedMessages = [...messages].sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b));
  const orderedActivity = [...activity].sort((a, b) => activityTimestampMs(a) - activityTimestampMs(b));
  const activityByInbound = new Map<string, AgentActivityTurn[]>();
  const unanchored: AgentActivityTurn[] = [];

  for (const turn of orderedActivity) {
    const inboundId = turn.inboundProviderMessageId?.trim();
    if (inboundId) {
      const list = activityByInbound.get(inboundId) || [];
      list.push(turn);
      activityByInbound.set(inboundId, list);
    } else {
      unanchored.push(turn);
    }
  }

  const timeline: TimelineItem[] = [];
  let unanchoredIndex = 0;

  for (const messageItem of orderedMessages) {
    const timestamp = messageTimestampMs(messageItem);
    while (unanchoredIndex < unanchored.length && activityTimestampMs(unanchored[unanchoredIndex]) <= timestamp) {
      const turn = unanchored[unanchoredIndex];
      timeline.push({ type: 'activity', timestamp: activityTimestampMs(turn), turn });
      unanchoredIndex += 1;
    }

    timeline.push({ type: 'message', timestamp, messageItem });

    const anchoredTurns = activityByInbound.get(messageItem.id) || [];
    for (const turn of anchoredTurns) {
      timeline.push({ type: 'activity', timestamp: activityTimestampMs(turn), turn });
    }
    activityByInbound.delete(messageItem.id);
  }

  while (unanchoredIndex < unanchored.length) {
    const turn = unanchored[unanchoredIndex];
    timeline.push({ type: 'activity', timestamp: activityTimestampMs(turn), turn });
    unanchoredIndex += 1;
  }

  for (const turns of activityByInbound.values()) {
    for (const turn of turns) {
      timeline.push({ type: 'activity', timestamp: activityTimestampMs(turn), turn });
    }
  }

  return timeline;
}

const MessagesPanel: React.FC<MessagesPanelProps> = ({
  selectedChat,
  loadingMessages,
  messages,
  messagesEndRef,
  onImageClick,
  onServiceCompleted,
  agentActivity = [],
}) => {
  // Estado del status de sesión: 'active' | 'pending' | null
  const [sessionStatus, setSessionStatus] = useState<'active' | 'pending' | 'open' | 'closed' | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  // NUEVO ESTADO PARA EL MODAL DE DOCUMENTOS
  const [previewingDoc, setPreviewingDoc] = useState<WhatsAppMessage | null>(null);
  const timeline = useMemo(() => buildTimeline(messages, agentActivity), [messages, agentActivity]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, selectedChat]);

  // Al cambiar de chat, obtener estado de sesión automáticamente
  useEffect(() => {
    let mounted = true;

    const loadSessionStatus = async () => {
      if (!selectedChat) {
        setSessionStatus(null);
        return;
      }

      try {
        const response = await getSessionStatus(selectedChat);
        if (mounted) {
          setSessionStatus(response.hasActiveSession ? 'active' : response.status);
        }
      } catch (err) {
        if ((err as any)?.response?.status === 429) {
          console.info('Estado de sesión omitido temporalmente por rate limit; se conserva el estado actual.');
          return;
        }

        console.warn('Error obteniendo estado de sesión:', err);
        if (mounted) {
          setSessionStatus(null);
        }
      }
    };

    loadSessionStatus();

    return () => { mounted = false; };
  }, [selectedChat]);

  // Renderiza la vista previa del media según tipo
  const renderMedia = (msg: WhatsAppMessage) => {
    // Verificar si hay media en la nueva estructura o en la legacy
    const hasMediaObject = msg.hasMedia && msg.media;
    const mediaUrl = hasMediaObject ? msg.media!.mediaUrl : msg.mediaUrl;
    const mimetype = hasMediaObject ? msg.media!.mimetype : msg.mimetype;
    const filename = hasMediaObject ? msg.media!.filename : msg.filename;
    
    if (!mediaUrl && !hasMediaObject) return null;
    
    if (msg.type === 'audio' || mimetype?.startsWith('audio/')) {
      // Para audio, pasar el mediaUrl directamente al componente
      // El componente AudioMessage se encargará de obtener la URL pública
      return <AudioMessageWrapper mediaUrl={mediaUrl || ''} messageId={msg.id} />;
    }
    
    // Para imágenes, videos, documentos, etc. usar ChatFilePreview
    return <ChatFilePreview msg={msg} onClick={() => {
      // ✅ Bloquear click si el archivo aún se está subiendo
      if (msg.isOptimistic) {
        console.log('⏳ Archivo aún subiendo, espera...');
        return;
      }
      
      const mime = mimetype ?? '';
      const isDoc = mime.startsWith('application/pdf') || mime.includes('officedocument') || mime.includes('spreadsheet') || mime.includes('presentation') || (filename ?? '').match(/\.(pdf|docx?|xlsx?|pptx?)$/i);
      
      // LÓGICA MODIFICADA
      if (isDoc) {
        // AHORA: Abrir el modal
        setPreviewingDoc(msg);
      } else if (msg.type === 'image' && onImageClick) {
        onImageClick(msg);
      }
      // Para videos: no hacer nada, se reproducen inline
    }} />;
  };

  return (
    <div className="relative flex-1 overflow-y-auto px-4 py-3 min-h-0 bg-gray-50 dark:bg-gray-900" style={{ overflowX: 'hidden' }}>
      {/* Barra superior sticky con botones */}
      <div
        className="sticky top-0 w-full flex justify-between items-center z-30 bg-transparent"
        style={{ height: 44 }}
      >
        <div className="m-2" />
        {/* Botón Servicio Realizado - color según estado de sesión y acción de finalizar */}
        <div className="m-2">
          {/**
           * Lógica visual:
           * - ROJO si sessionStatus === 'active' (hay atención pendiente) - botón habilitado
           * - VERDE si sessionStatus != 'active' (sin atención) - botón deshabilitado
           */}
          <button
            className="shadow rounded flex items-center justify-center transition-colors"
            style={{
              width: 40,
              height: 40,
              // Rojo si está activo, verde si no
              backgroundColor: sessionStatus === 'active' ? '#fca5a5' : '#a7f3d0',
            }}
            aria-label="Finalizar atención"
            title={sessionStatus === 'active' ? 'Finalizar atención' : 'Sin atención'}
            onClick={async () => {
              if (!selectedChat || sessionStatus !== 'active' || isFinishing) return;

              try {
                setIsFinishing(true);
                await completeSession(selectedChat);
                // Después de completar, marcar como finalizado
                setSessionStatus(null);
                onServiceCompleted?.();
              } catch (err) {
                console.error('Error finalizando sesión:', err);
              } finally {
                setIsFinishing(false);
              }
            }}
            disabled={isFinishing || sessionStatus !== 'active'}
          >
            <CheckCheck
              size={28}
              className={sessionStatus === 'active' ? "text-red-700" : "text-green-800"}
            />
          </button>
        </div>
      </div>

      {/* Mensajes */}
      {selectedChat ? (
        loadingMessages ? (
          <div className="text-center text-gray-400 dark:text-gray-500 pt-10">Cargando mensajes...</div>
        ) : (
          <div>
            {messages.length === 0 ? (
              <div className="text-center text-gray-400 dark:text-gray-500 pt-10">No hay mensajes en este chat</div>
            ) : (
              <>
                {timeline.map((item) => item.type === 'activity' ? (
                    <AgentActivityRow key={`activity-${item.turn.id}`} turn={item.turn} />
                  ) : (
                  <div key={item.messageItem.id} className={`mb-2 flex ${item.messageItem.fromMe ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`rounded-xl px-3 py-2 max-w-xs ${
                        item.messageItem.fromMe ? 'bg-green-100 dark:bg-green-900/40 text-right' : 'bg-white dark:bg-gray-800 text-left'
                      } shadow break-words relative ${
                        item.messageItem.isOptimistic ? 'opacity-70' : ''
                      }`}
                      style={{
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        whiteSpace: 'pre-line',
                        minWidth: 0,
                      }}
                    >
                      {/* ✅ Indicador de subida */}
                      {item.messageItem.isOptimistic && !item.messageItem.uploadError && (
                        <div className="absolute top-1 right-1 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                          <div className="animate-spin rounded-full h-3 w-3 border-b border-gray-500 dark:border-gray-400"></div>
                          Subiendo...
                        </div>
                      )}
                      {/* ✅ Indicador de error */}
                      {item.messageItem.uploadError && (
                        <div className="absolute top-1 right-1 text-xs text-red-500 dark:text-red-400 flex items-center gap-1">
                          ⚠️ Error al enviar
                        </div>
                      )}
                      
                      {renderMedia(item.messageItem)}
                      {item.messageItem.body && (
                        <div className="text-sm text-gray-800 dark:text-gray-200 mb-1">
                          {item.messageItem.body.split(/(https?:\/\/\S+)/g).map((part, i) => {
                            if (part.startsWith('https://') || part.startsWith('http://')) {
                              return (
                                <a
                                  key={i}
                                  href={part}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 dark:text-blue-400 underline break-all"
                                >
                                  {part}
                                </a>
                              );
                            }
                            return part;
                          })}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap justify-end gap-x-2 text-xs text-gray-600 dark:text-gray-300">
                        {item.messageItem.fromMe && deliveryLabel(item.messageItem.status) && <span>{deliveryLabel(item.messageItem.status)}</span>}
                        <span>{new Date(item.messageItem.timestamp * 1000).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        )
      ) : (
        <div className="text-center text-gray-500 dark:text-gray-400">
          {/* ... (Mensaje "Selecciona un chat") ... */}
        </div>
      )}

      {/* NUEVO: Modal de vista previa de documento */}
      {previewingDoc && <DocumentPreviewModal
        doc={previewingDoc}
        onClose={() => setPreviewingDoc(null)}
      />}
    </div>
  );
};

export default MessagesPanel;
