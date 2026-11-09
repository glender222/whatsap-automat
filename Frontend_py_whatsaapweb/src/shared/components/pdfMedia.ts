import { isAxiosError } from 'axios';
import { api } from '../axios/http';

export function isPdfFile(mimeType?: string | null, fileName?: string | null) {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase() === 'application/pdf' || /\.pdf$/i.test(fileName ?? '');
}

function protectedPath(resource: URL, apiBase: URL, pageOrigin: string) {
  if (resource.origin !== apiBase.origin && resource.origin !== pageOrigin) return null;
  const apiPrefix = apiBase.pathname.replace(/\/$/, '') + '/media/';
  for (const prefix of [apiPrefix, '/api/media/', '/media/']) {
    if (resource.pathname.startsWith(prefix) && resource.pathname.length > prefix.length) {
      return '/media/' + resource.pathname.slice(prefix.length) + resource.search;
    }
  }
  return null;
}

export async function loadPdfBlob(source: string, signal: AbortSignal) {
  if (!source) throw new Error('El documento no tiene una dirección disponible.');
  const resource = new URL(source, window.location.origin);
  const apiBase = new URL(api.defaults.baseURL ?? '/api', window.location.origin);
  const endpoint = protectedPath(resource, apiBase, window.location.origin);
  let blob: Blob;
  if (endpoint) {
    try {
      const { data } = await api.get<Blob>(endpoint, { responseType: 'blob', signal });
      blob = data;
    } catch (cause) {
      if (isAxiosError(cause) && [401, 403].includes(cause.response?.status ?? 0)) {
        throw new Error('Tu sesión no tiene acceso a este documento.');
      }
      throw cause;
    }
  } else {
    if (!['http:', 'https:', 'blob:', 'data:'].includes(resource.protocol) || resource.username || resource.password) {
      throw new Error('La dirección del documento no es válida.');
    }
    const response = await fetch(resource.href, { credentials: 'omit', redirect: 'error', signal });
    if (!response.ok) throw new Error('No se pudo obtener el documento.');
    blob = await response.blob();
  }
  if (!(blob instanceof Blob) || !(await blob.slice(0, 1024).text()).includes('%PDF-')) {
    throw new Error('El servidor no devolvió un archivo PDF.');
  }
  return blob;
}
