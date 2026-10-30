import React, { useEffect, useState, useRef } from 'react';
import FilePreview from '../../../../shared/components/FilePreview';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';
import { FileText, FileSpreadsheet, Presentation, FileArchive, File } from 'lucide-react';
import { useIndexedMessages } from '../../hooks/useIndexedMessages';
import { fetchMediaObjectUrlAPI } from '../../services/mediaService';
import { mediaQueue } from '../../services/mediaRequestQueue';

interface ChatFilePreviewProps {
    msg: WhatsAppMessage;
    onClick?: () => void;
    chatId?: string;
}

const ChatFilePreview: React.FC<ChatFilePreviewProps> = ({ msg, onClick, chatId }) => {
    // Extraer información del media desde la estructura de la API
    const hasMediaObject = msg.hasMedia && msg.media;
    const mime = hasMediaObject ? (msg.media!.mimetype ?? '') : (msg.mimetype ?? '');
    const name = hasMediaObject ? (msg.media!.filename ?? '') : (msg.filename ?? '');
    const mediaApiUrl = hasMediaObject ? msg.media!.mediaUrl : (msg.mediaUrl ?? '');
    
    // Usar hook para obtener blob local si existe
    const { getMediaBlob } = useIndexedMessages(msg.chatId || chatId || '');
    const [localUrl, setLocalUrl] = useState<string | undefined>(undefined);
    const [remoteObjectUrl, setRemoteObjectUrl] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState(false);
    const [isVisible, setIsVisible] = useState(false);
    
    // Refs para control
    const containerRef = useRef<HTMLDivElement>(null);
    const isLoadingRef = useRef(false);
    const hasLoadedRef = useRef(false);
    const remoteObjectUrlRef = useRef<string | undefined>(undefined);

    // Intersection Observer para lazy loading
    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !hasLoadedRef.current) {
                        setIsVisible(true);
                    }
                });
            },
            {
                root: null,
                rootMargin: '100px', // Cargar 100px antes de que sea visible
                threshold: 0.01,
            }
        );
        
        observer.observe(element);
        
        return () => {
            observer.disconnect();
        };
    }, []);

    // Cargar media solo cuando es visible
    useEffect(() => {
        // No cargar si no es visible, no hay media, ya se cargó, o está cargando
        if (!isVisible || !msg.id || !mediaApiUrl || hasLoadedRef.current || isLoadingRef.current) {
            return;
        }
        
        let mounted = true;
        isLoadingRef.current = true;
        hasLoadedRef.current = true;
        setLoading(true);
        
        const loadMedia = async () => {
            try {
                // Importar cache service
                // 1. PRIMERO: Intentar blob local de IndexedDB
                const localBlob = await getMediaBlob(msg.id);
                if (mounted && localBlob) {
                    setLocalUrl(localBlob);
                    setLoading(false);
                    isLoadingRef.current = false;
                    return;
                }
                
                // 2. SEGUNDO: Descargar desde backend con Authorization y convertir a blob URL.
                // Prioridad: archivos más arriba = mayor prioridad (menor número)
                const priority = 5; // Prioridad media por defecto
                
                const objectUrl = await mediaQueue.enqueue(
                    msg.id, // ID único
                    () => fetchMediaObjectUrlAPI(mediaApiUrl || msg.id), // Función a ejecutar
                    priority
                );
                
                if (mounted && objectUrl) {
                    if (remoteObjectUrlRef.current) {
                        URL.revokeObjectURL(remoteObjectUrlRef.current);
                    }
                    remoteObjectUrlRef.current = objectUrl;
                    setRemoteObjectUrl(objectUrl);
                }
            } catch (error) {
                console.warn(`⚠️ Error cargando media ${msg.id}:`, error);
            } finally {
                if (mounted) {
                    setLoading(false);
                    isLoadingRef.current = false;
                }
            }
        };
        
        loadMedia();
        
        return () => { 
            mounted = false;
            if (remoteObjectUrlRef.current) {
                URL.revokeObjectURL(remoteObjectUrlRef.current);
                remoteObjectUrlRef.current = undefined;
            }
        };
        // eslint-disable-next-line
    }, [isVisible, msg.id, mediaApiUrl]);

    // --- LÓGICA MODIFICADA ---
    // Es video si el mime es video O si el nombre termina en una extensión de video
    // ✅ EXPANDIDO: Más formatos de video soportados
    const isVideo = mime.startsWith('video/') || (name && name.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|3gpp|asf|mpg|mpeg|m2v|m4v|f4v|f4p|f4a|f4b)$/i));

    // Es documento SI NO ES VIDEO y coincide con tipos de documento
    const isDoc = !isVideo && (
        mime.startsWith('application/pdf') ||
        mime.includes('officedocument') ||
        mime.includes('spreadsheet') ||
        mime.includes('presentation') ||
        (name && name.match(/\.(pdf|docx?|xlsx?|pptx?|doc|xls|ppt|csv|zip|rar|7z|tar|gz)$/i))
    );
    // --- FIN LÓGICA MODIFICADA ---


    if (isDoc) {
        // Documentos no necesitan lazy loading (solo iconos)
        // Elegir icono y color según extensión
        const ext = name.split('.').pop()?.toLowerCase() || '';
        let Icon = FileText;
        let bgColor = 'bg-gray-100';
        let iconColor = 'text-gray-500';
        let borderColor = 'border-gray-300';
        
        // Word - Azul
        if (["doc", "docx"].includes(ext)) {
            Icon = File;
            bgColor = 'bg-blue-50';
            iconColor = 'text-blue-600';
            borderColor = 'border-blue-200';
        }
        // Excel - Verde
        else if (["xls", "xlsx", "csv"].includes(ext)) {
            Icon = FileSpreadsheet;
            bgColor = 'bg-green-50';
            iconColor = 'text-green-600';
            borderColor = 'border-green-200';
        }
        // PowerPoint - Naranja
        else if (["ppt", "pptx"].includes(ext)) {
            Icon = Presentation;
            bgColor = 'bg-orange-50';
            iconColor = 'text-orange-600';
            borderColor = 'border-orange-200';
        }
        // PDF - Rojo
        else if (["pdf"].includes(ext)) {
            Icon = FileText;
            bgColor = 'bg-red-50';
            iconColor = 'text-red-600';
            borderColor = 'border-red-200';
        }
        // Archivos comprimidos - Morado
        else if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
            Icon = FileArchive;
            bgColor = 'bg-purple-50';
            iconColor = 'text-purple-600';
            borderColor = 'border-purple-200';
        }

        const isUploading = msg.isOptimistic && !msg.uploadError;
        
        return (
            <div
                className={`flex items-center gap-3 p-3 rounded-lg border ${borderColor} ${bgColor} max-w-xs ${
                    isUploading ? 'cursor-wait opacity-60' : 'cursor-pointer hover:shadow-md'
                } transition-shadow`}
                onClick={onClick}
                title={isUploading ? 'Subiendo archivo...' : 'Click para abrir'}
            >
                {/* Icono del tipo de archivo */}
                <div className={`flex-shrink-0 w-12 h-12 flex items-center justify-center rounded-lg ${bgColor} border ${borderColor} relative`}>
                    {isUploading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-90 rounded-lg">
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500"></div>
                        </div>
                    )}
                    <Icon size={28} className={iconColor} />
                </div>
                
                {/* Información del archivo */}
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                        {ext.toUpperCase()} • Documento
                    </div>
                </div>
            </div>
        );
    }

    if (isVideo) {
        // Usar la URL disponible: local > pública > construida
        const videoUrl = localUrl || remoteObjectUrl;
        
        return (
            <div ref={containerRef} className="flex flex-col items-center w-full relative">
                {(loading || !isVisible) && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-lg z-10">
                        <div className="flex flex-col items-center">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mb-2"></div>
                            <div className="text-xs text-white">
                                {!isVisible ? 'Esperando...' : 'Cargando video...'}
                            </div>
                        </div>
                    </div>
                )}
                <video
                    controls
                    preload="metadata"
                    className="rounded-lg shadow-sm max-w-full w-64 h-auto bg-black"
                    style={{ minHeight: '180px' }}
                >
                    {videoUrl && (
                        <>
                            <source src={videoUrl} type={mime || 'video/mp4'} />
                            {/* Fallback para formatos no estándar */}
                            <source src={videoUrl} type="video/mp4" />
                            <source src={videoUrl} type="video/webm" />
                        </>
                    )}
                    Tu navegador no soporta la reproducción de video.
                </video>
                {name && (
                    <div className="text-xs text-gray-500 mt-1 text-center truncate max-w-[180px]">
                        {name}
                    </div>
                )}
            </div>
        );
    }


    // Imágenes y otros
    // Usar la URL disponible: local > pública > construida (solo si es visible)
    const mediaUrl = localUrl || remoteObjectUrl || (msg.isOptimistic ? mediaApiUrl : '');
    
    return (
        <div ref={containerRef} className="cursor-pointer relative" onClick={onClick}>
            {(!isVisible || loading) && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-100 rounded-lg z-10">
                    <div className="flex flex-col items-center">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mb-1"></div>
                        <div className="text-xs text-gray-500">
                            {!isVisible ? 'Esperando...' : 'Cargando...'}
                        </div>
                    </div>
                </div>
            )}
            {mediaUrl && <FilePreview url={mediaUrl} mimeType={mime} fileName={name} />}
            {name && (
                <div className="text-xs text-gray-500 mt-1 text-center">{name}</div>
            )}
        </div>
    );
};

export default ChatFilePreview;
