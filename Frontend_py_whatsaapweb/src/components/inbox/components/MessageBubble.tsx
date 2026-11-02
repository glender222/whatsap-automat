import React from 'react';
import type { OmnichannelMessage } from '../types';
import {
  Bot,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  FileText,
  Headphones,
} from 'lucide-react';

export interface MessageBubbleProps {
  message: OmnichannelMessage;
  onRetryFailedMessage?: (messageId: string) => void;
  className?: string;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  onRetryFailedMessage,
  className = '',
}) => {
  const isCustomer = message.senderType === 'customer';
  const isOperator = message.senderType === 'operator';
  const isAgent = message.senderType === 'agent';
  const isSystem = message.senderType === 'system';

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderStatusIcon = () => {
    switch (message.status) {
      case 'sending':
        return <Clock size={12} className="text-slate-300 animate-spin" aria-label="Enviando" />;
      case 'sent':
        return <Check size={12} className="text-slate-300" aria-label="Enviado" />;
      case 'delivered':
        return <CheckCheck size={12} className="text-slate-300" aria-label="Entregado" />;
      case 'read':
        return <CheckCheck size={12} className="text-teal-200" aria-label="Leído" />;
      case 'failed':
        return (
          <button
            type="button"
            onClick={() => onRetryFailedMessage?.(message.id)}
            className="flex items-center gap-0.5 text-red-300 hover:text-white"
            title="Error al enviar. Haz clic para reintentar."
            aria-label="Error al enviar mensaje. Presiona para reintentar."
          >
            <AlertCircle size={12} />
            <span className="text-[9px] underline">Reintentar</span>
          </button>
        );
      default:
        return null;
    }
  };

  if (isSystem) {
    return (
      <div
        className={`flex justify-center my-2 ${className}`}
        role="status"
        aria-label={`Mensaje del sistema: ${message.body}`}
      >
        <span className="rounded-full bg-slate-100 dark:bg-slate-800/80 px-3 py-1 text-[11px] text-slate-500 dark:text-slate-400 border border-slate-200/60 dark:border-slate-700/60">
          {message.body}
        </span>
      </div>
    );
  }

  const ariaLabel = isCustomer
    ? `Mensaje de cliente ${message.senderName} a las ${formatTime(message.timestamp)}: ${message.body}`
    : isOperator
    ? `Mensaje de operador ${message.senderName} a las ${formatTime(message.timestamp)}: ${message.body}, entrega ${message.status}`
    : `Respuesta de agente IA ${message.agentModelUsed || 'Automat'} a las ${formatTime(message.timestamp)}: ${message.body}`;

  return (
    <article
      aria-label={ariaLabel}
      className={`flex flex-col ${isCustomer ? 'items-start' : 'items-end'} my-1.5 ${className}`}
    >
      {/* Agent Tag Header */}
      {isAgent && (
        <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] font-medium text-teal-700 dark:text-teal-300">
          <Bot size={13} className="shrink-0" aria-hidden="true" />
          <span>{message.agentModelUsed || 'Agente IA (Automat)'}</span>
          {message.agentConfidenceScore !== undefined && (
            <span className="rounded bg-teal-100 dark:bg-teal-950/60 px-1 py-0.2 text-[9px] font-bold text-teal-800 dark:text-teal-200">
              {Math.round(message.agentConfidenceScore * 100)}%
            </span>
          )}
        </div>
      )}

      {/* Bubble Container */}
      <div
        className={`relative max-w-[85%] md:max-w-lg rounded-2xl px-4 py-2.5 text-xs shadow-sm transition-shadow ${
          isCustomer
            ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 rounded-bl-sm'
            : isOperator
            ? 'bg-teal-600 text-white rounded-br-sm'
            : 'bg-slate-50 dark:bg-slate-850 text-slate-900 dark:text-slate-100 border border-teal-200/80 dark:border-teal-800/50 rounded-tl-sm'
        }`}
      >
        {/* Media Attachments */}
        {message.mediaUrl && (
          <div className="mb-2 overflow-hidden rounded-lg">
            {message.mediaType === 'image' && (
              <img
                src={message.mediaUrl}
                alt={message.fileName || 'Imagen adjunta'}
                className="max-h-60 w-full object-cover rounded-md"
              />
            )}
            {message.mediaType === 'document' && (
              <a
                href={message.mediaUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-md bg-white/20 dark:bg-black/20 p-2 text-inherit hover:underline"
              >
                <FileText size={18} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{message.fileName || 'Documento adjunto'}</p>
                  {message.fileSizeBytes && (
                    <p className="text-[10px] opacity-80">
                      {(message.fileSizeBytes / 1024).toFixed(1)} KB
                    </p>
                  )}
                </div>
              </a>
            )}
            {message.mediaType === 'audio' && (
              <div className="flex items-center gap-2 rounded-md bg-white/20 dark:bg-black/20 p-2">
                <Headphones size={16} />
                <span className="text-[11px]">Mensaje de voz</span>
              </div>
            )}
          </div>
        )}

        {/* Text Body */}
        <p className="whitespace-pre-wrap leading-relaxed break-words">{message.body}</p>

        {/* Trace ID indicator if available */}
        {message.agentTraceId && (
          <p className="mt-1 text-[9px] opacity-60 font-mono">Trace: {message.agentTraceId}</p>
        )}
      </div>

      {/* Meta Footer */}
      <div className="flex items-center gap-1.5 mt-1 px-1 text-[10px] text-slate-400">
        <span>{message.senderName}</span>
        <span>·</span>
        <time dateTime={new Date(message.timestamp).toISOString()}>{formatTime(message.timestamp)}</time>
        {!isCustomer && <span className="ml-0.5">{renderStatusIcon()}</span>}
      </div>
    </article>
  );
};
