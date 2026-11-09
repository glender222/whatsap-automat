import React, { useState, useMemo } from 'react';
import FilePreview from '../../../../shared/components/FilePreview';
import PdfDocumentDialog from '../../../../shared/components/PdfDocumentDialog';
import { isPdfFile } from '../../../../shared/components/pdfMedia';
import AvatarCircle from './AvatarCircle';
import { getMediaUrl } from '../../../../shared/utils/urls';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';

interface UserInfo {
  name: string;
  number: string;
  photoUrl?: string | null;
}
interface UserMediaPanelProps {
  userInfo: UserInfo;
  allMedia: WhatsAppMessage[];
  onMediaClick: (msg: WhatsAppMessage) => void;
}

const UserMediaPanel: React.FC<UserMediaPanelProps> = ({
  userInfo,
  allMedia,
  onMediaClick
}) => {

  // --- LÓGICA DE FILTRADO CORREGIDA ---
  // Usamos useMemo para evitar recalcular esto en cada render
  const { images, videos, docs } = useMemo(() => {
    const images: WhatsAppMessage[] = [];
    const videos: WhatsAppMessage[] = [];
    const docs: WhatsAppMessage[] = [];

    allMedia.forEach(m => {
      const mime = m.mimetype ?? '';
      const name = m.filename ?? '';

      // 1. Prioridad: Videos (usando la lógica robusta)
      // ✅ EXPANDIDO: Más formatos de video soportados
      const isVideo = mime.startsWith('video/') || (name && name.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|3gpp|asf|mpg|mpeg|m2v|m4v|f4v|f4p|f4a|f4b)$/i));
      if (isVideo) {
        videos.push(m);
        return; // Ya clasificado, saltar al siguiente
      }

      // 2. Imágenes (asegurándonos de que no sean videos)
      const isImage = (m.type === 'image' || mime.startsWith('image/'));
      if (isImage) {
        images.push(m);
        return; // Ya clasificado
      }

      // 3. Documentos (todo lo demás que califique)
      const isDoc = m.type === 'document' ||
        isPdfFile(mime, name) ||
        mime.includes('officedocument') ||
        mime.includes('spreadsheet') ||
        mime.includes('presentation') ||
        (name && name.match(/\.(docx?|xlsx?|pptx?|doc|xls|ppt|csv|zip|rar|7z|tar|gz)$/i));

      if (isDoc) {
        docs.push(m);
      }
    });

    return { images, videos, docs };
  }, [allMedia]); // Depende de allMedia
  // --- FIN DE LÓGICA CORREGIDA ---


  const [selectedDoc, setSelectedDoc] = useState<null | typeof docs[0]>(null);

  return (
    <div className="flex flex-col items-center px-5 py-6 h-full">
      {/* Avatar y nombre */}
      <AvatarCircle src={userInfo.photoUrl} alt={userInfo.name} size={70} />
      <div className="mt-2 font-semibold text-lg text-gray-900">{userInfo.name}</div>
      <div className="text-xs text-gray-500 mb-2">{userInfo.number}</div>
      <hr className="w-full my-2" />

      {/* Archivos, imágenes y documentos */}
      <div className="w-full mb-2 font-semibold text-sm text-gray-700">Archivos, enlaces y documentos</div>

      {/* Galería horizontal de imágenes */}
      {images.length > 0 && (
        <div className="flex overflow-x-auto w-full gap-2 mb-3">
          {images.map(img => (
            <img
              key={img.id}
              src={getMediaUrl(img.mediaUrl || '')}
              alt={img.filename || ""}
              className="h-16 w-16 rounded object-cover cursor-pointer border border-gray-300"
              onClick={() => onMediaClick(img)}
            />
          ))}
        </div>
      )}

      {/* Galería horizontal de videos */}
      {videos.length > 0 && (
        <div className="flex overflow-x-auto w-full gap-2 mb-3">
          {videos.map(vid => (
            <div
              key={vid.id}
              className="relative h-16 w-16 rounded overflow-hidden cursor-pointer border border-gray-300 bg-black flex items-center justify-center"
              // REVERTIR A onMediaClick
              onClick={() => onMediaClick(vid)}
              title={vid.filename || ''}
            >
              <div className="absolute inset-0 w-full h-full bg-black opacity-70" />
              <span className="absolute inset-0 flex items-center justify-center text-white text-2xl pointer-events-none">
                ▶
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Documentos */}
      {docs.length > 0 && (
        <div className="w-full mt-2">
          <div className="font-semibold text-xs text-gray-600 mb-1">Documentos:</div>
          {docs.map(doc => (
            <div key={doc.id} className="flex items-center gap-2 mb-1">
              <button
                type="button"
                className="text-blue-600 underline text-xs hover:text-blue-800"
                onClick={() => setSelectedDoc(doc)}
              >
                {doc.filename || "Archivo"}
              </button>
            </div>
          ))}

          {/* Modal de vista previa de documento */}
          {selectedDoc && (isPdfFile(selectedDoc.mimetype, selectedDoc.filename) ? (
            <PdfDocumentDialog url={selectedDoc.mediaUrl || `/api/media/${encodeURIComponent(selectedDoc.id)}`}
              fileName={selectedDoc.filename ?? ''} onClose={() => setSelectedDoc(null)} />
          ) : (
            <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-lg shadow-lg p-4 max-w-3xl w-full max-h-[90vh] overflow-auto relative">

                <button
                  className="absolute top-2 right-2 text-gray-500 hover:text-gray-800 text-2xl font-bold z-10"
                  onClick={() => setSelectedDoc(null)}
                  aria-label="Cerrar vista previa"
                >
                  ×
                </button>

                <a
                  href={getMediaUrl(selectedDoc.mediaUrl || '')}
                  download={selectedDoc.filename ?? 'archivo'}
                  className="absolute top-2 left-3 px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 z-10"
                >
                  Descargar
                </a>

                <h3 className="text-lg font-semibold mb-2 text-center pt-1 px-16 truncate">
                  {selectedDoc.filename}
                </h3>

                <div className="max-h-[75vh] overflow-auto">
                  <FilePreview
                    url={getMediaUrl(selectedDoc.mediaUrl || '')}
                    mimeType={selectedDoc.mimetype ?? ''}
                    fileName={selectedDoc.filename ?? ''}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default UserMediaPanel;
