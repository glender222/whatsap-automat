import React from 'react';
// @ts-ignore
import ReactPlayer from 'react-player';
import { Worker, Viewer } from '@react-pdf-viewer/core';
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
// @ts-ignore
import { renderAsync } from 'docx-preview';

export type FilePreviewProps = {
  url: string;
  mimeType?: string;
  fileName?: string;
};

// --- LÓGICA MODIFICADA ---
const isImage = (type: string) => /image\/(jpeg|png|gif|webp)/.test(type);
// AHORA TAMBIÉN REVISA EL NOMBRE DEL ARCHIVO
// ✅ EXPANDIDO: Más formatos de video soportados
const isVideo = (type: string, name: string) => /video\/.*/.test(type) || (name && name.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|3gpp|asf|mpg|mpeg|m2v|m4v|f4v|f4p|f4a|f4b)$/i));
const isPdf = (type: string, name: string) => type === 'application/pdf' || (name && name.endsWith('.pdf'));
const isDocx = (type: string, name: string) => type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || (name && name.endsWith('.docx'));
const isSticker = (type: string, name: string) => type === 'image/webp' || (name && name.endsWith('.webp'));
// --- FIN LÓGICA MODIFICADA ---

// Componente de vista previa de DOCX
const DocxPreview: React.FC<{ url: string }> = ({ url }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        if (ref.current) {
          renderAsync(blob, ref.current);
        }
      });
  }, [url]);
  return <div ref={ref} style={{ width: '100%', minHeight: 400, background: '#f8f8f8' }} />;
};


export const FilePreview: React.FC<FilePreviewProps> = ({ url, mimeType = '', fileName = '' }) => {
  
  // --- LÓGICA MODIFICADA (Video tiene prioridad) ---
  if (isVideo(mimeType, fileName)) {
    // @ts-ignore
    return <ReactPlayer url={url} controls width="100%" height="360px" />;
  }
  // --- FIN LÓGICA MODIFICADA ---

  if (isPdf(mimeType, fileName)) {
    return (
      <Worker workerUrl="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js">
        <Viewer fileUrl={url} />
      </Worker>
    );
  }

  if (isSticker(mimeType, fileName)) {
    // Sticker o webp: más pequeño
    return <img src={url} alt={fileName} style={{ maxWidth: 96, maxHeight: 96, objectFit: 'contain', display: 'block', margin: '0 auto' }} />;
  }

  if (isImage(mimeType)) {
    // Imagen normal o gif
    const isGif = mimeType === 'image/gif' || fileName.endsWith('.gif');
    return <img src={url} alt={fileName} style={{ maxWidth: isGif ? 120 : '100%', maxHeight: isGif ? 120 : 400, objectFit: 'contain', display: 'block', margin: '0 auto' }} />;
  }

  if (isDocx(mimeType, fileName)) {
    // DOCX preview usando docx-preview
    return <DocxPreview url={url} />;
  }

  // Office docs (pptx, xlsx) fallback: Google Docs Viewer
  if (fileName.endsWith('.pptx') || fileName.endsWith('.xlsx')) {
    return (
      <iframe
        src={`https://docs.google.com/gview?url=${encodeURIComponent(url)}&embedded=true`}
        style={{ width: '100%', height: 500, border: 'none' }}
        title={fileName}
      />
    );
  }

  // Default: download link
  return <a href={url} download={fileName}>Descargar {fileName}</a>;
};

export default FilePreview;