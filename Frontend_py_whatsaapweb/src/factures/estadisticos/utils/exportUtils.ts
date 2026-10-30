// src/factures/estadisticos/utils/exportUtils.ts

import type { ChatHistoryExport } from '../services/reportsService';

/**
 * Convierte el historial de chat a formato CSV
 */
export function exportToCsv(data: ChatHistoryExport): void {
  const headers = ['Timestamp', 'Fecha', 'Hora', 'Remitente', 'Mensaje', 'Tipo', 'Tiene Media'];
  
  const rows = data.messages.map(msg => {
    const date = new Date(msg.timestamp);
    return [
      msg.timestamp,
      date.toLocaleDateString('es-ES'),
      date.toLocaleTimeString('es-ES'),
      msg.sender,
      `"${msg.body.replace(/"/g, '""')}"`,
      msg.type,
      msg.hasMedia ? 'Sí' : 'No'
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');

  downloadFile(
    csvContent,
    `chat_${sanitizeFilename(data.chatName)}_${new Date().toISOString().split('T')[0]}.csv`,
    'text/csv;charset=utf-8;'
  );
}

/**
 * Convierte el historial de chat a formato JSON
 */
export function exportToJson(data: ChatHistoryExport): void {
  const jsonContent = JSON.stringify(data, null, 2);

  downloadFile(
    jsonContent,
    `chat_${sanitizeFilename(data.chatName)}_${new Date().toISOString().split('T')[0]}.json`,
    'application/json'
  );
}

/**
 * Función auxiliar para descargar archivos
 */
function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Sanitiza nombres de archivo
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 50);
}

/**
 * Exporta múltiples chats en un solo archivo JSON
 */
export function exportMultipleChatsToJson(chats: ChatHistoryExport[]): void {
  const jsonContent = JSON.stringify({
    exportDate: new Date().toISOString(),
    totalChats: chats.length,
    totalMessages: chats.reduce((sum, chat) => sum + chat.messages.length, 0),
    chats
  }, null, 2);

  downloadFile(
    jsonContent,
    `chats_export_${new Date().toISOString().split('T')[0]}.json`,
    'application/json'
  );
}
