// src/factures/mensajeria/components/bandeja de chats/FilePreviewCard.tsx

import React from 'react';
import { X, FileImage, FileVideo, FileAudio, FileText, File, Download, Play } from 'lucide-react';
import type { FilePreview } from '../../../../shared/types/wsp';

interface FilePreviewCardProps {
  filePreview: FilePreview;
  forceAsDocument?: boolean; // ✅ NUEVO: Si se enviará como documento
  onRemove: () => void;
  onToggleSendMode?: () => void; // ✅ NUEVO: Función para alternar modo
}

const FilePreviewCard: React.FC<FilePreviewCardProps> = ({ 
  filePreview, 
  forceAsDocument = false, 
  onRemove,
  onToggleSendMode
}) => {
  const { file, preview, type } = filePreview;

  // ✅ NUEVO: Verificar si el archivo puede enviarse como media o documento
  const canToggleSendMode = type === 'video' || type === 'image';
  const willSendAsDocument = forceAsDocument || type === 'document' || type === 'audio';

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const getIcon = () => {
    switch (type) {
      case 'image':
        return <FileImage size={24} className="text-blue-500" />;
      case 'video':
        return <FileVideo size={24} className="text-purple-500" />;
      case 'audio':
        return <FileAudio size={24} className="text-green-500" />;
      case 'document':
        return file.type === 'application/pdf' 
          ? <FileText size={24} className="text-red-500" />
          : <File size={24} className="text-gray-500" />;
      default:
        return <File size={24} className="text-gray-500" />;
    }
  };

  const getBgColor = () => {
    switch (type) {
      case 'image':
        return 'bg-blue-50 border-blue-200';
      case 'video':
        return 'bg-purple-50 border-purple-200';
      case 'audio':
        return 'bg-green-50 border-green-200';
      case 'document':
        return file.type === 'application/pdf' 
          ? 'bg-red-50 border-red-200'
          : 'bg-gray-50 border-gray-200';
      default:
        return 'bg-gray-50 border-gray-200';
    }
  };

  return (
    <div className={`mb-3 p-3 rounded-lg border-2 ${getBgColor()} flex items-start gap-3 animate-fadeIn`}>
      {/* Vista previa o icono */}
      <div className="flex-shrink-0">
        {type === 'image' ? (
          <img
            src={preview}
            alt={file.name}
            className="w-16 h-16 object-cover rounded border border-gray-300"
          />
        ) : type === 'video' ? (
          <video
            src={preview}
            className="w-16 h-16 object-cover rounded border border-gray-300"
          />
        ) : (
          <div className="w-16 h-16 flex items-center justify-center bg-white rounded border border-gray-300">
            {getIcon()}
          </div>
        )}
      </div>

      {/* Información del archivo */}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-gray-800 truncate mb-1">
          {file.name}
        </div>
        <div className="text-xs text-gray-500">
          {formatFileSize(file.size)}
        </div>
        <div className="text-xs text-gray-400 mt-1">
          {type === 'image' && 'Imagen'}
          {type === 'video' && 'Video'}
          {type === 'audio' && 'Audio'}
          {type === 'document' && (file.type === 'application/pdf' ? 'PDF' : 'Documento')}
          
          {/* ✅ NUEVO: Indicador de modo de envío */}
          {willSendAsDocument && (
            <span className="ml-2 text-xs bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded">
              <Download size={10} className="inline mr-1" />
              Como documento
            </span>
          )}
          {!willSendAsDocument && (type === 'video' || type === 'image') && (
            <span className="ml-2 text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">
              <Play size={10} className="inline mr-1" />
              Reproducible
            </span>
          )}
        </div>
      </div>

      {/* ✅ NUEVO: Botón para alternar modo de envío (solo para imágenes y videos) */}
      {canToggleSendMode && onToggleSendMode && (
        <button
          onClick={onToggleSendMode}
          className="flex-shrink-0 p-1 hover:bg-gray-200 rounded-full transition-colors mr-1"
          aria-label={forceAsDocument ? 'Enviar como media' : 'Enviar como documento'}
          title={forceAsDocument ? 'Cambiar a reproducible' : 'Cambiar a documento'}
        >
          {forceAsDocument ? (
            <Play size={16} className="text-blue-600" />
          ) : (
            <Download size={16} className="text-orange-600" />
          )}
        </button>
      )}

      {/* Botón eliminar */}
      <button
        onClick={onRemove}
        className="flex-shrink-0 p-1 hover:bg-gray-200 rounded-full transition-colors"
        aria-label="Eliminar archivo"
      >
        <X size={20} className="text-gray-600" />
      </button>
    </div>
  );
};

export default FilePreviewCard;