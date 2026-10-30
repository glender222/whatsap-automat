import React from 'react';
import { MessageSquare, X } from 'lucide-react';

interface QuickRepliesProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectReply: (text: string) => void;
}

/**
 * Panel de Respuestas Rápidas
 * Muestra botones con respuestas predefinidas que se insertan en el input
 */
const QuickReplies: React.FC<QuickRepliesProps> = ({ isOpen, onClose, onSelectReply }) => {
    // Respuestas predefinidas
    const quickReplies = [
        { id: 1, text: 'Gracias por contactarnos, en un momento le atendemos.', emoji: '👋' },
        { id: 2, text: '¿En qué podemos ayudarle?', emoji: '❓' },
        { id: 3, text: 'Su solicitud ha sido recibida.', emoji: '✅' },
        { id: 4, text: 'Estamos procesando su pedido.', emoji: '⏳' },
        { id: 5, text: '¿Tiene alguna otra consulta?', emoji: '💬' },
        { id: 6, text: 'Gracias por su preferencia.', emoji: '🙏' },
    ];

    if (!isOpen) return null;

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 mx-2 z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                        <MessageSquare size={16} />
                        <span>Respuestas Rápidas</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                        aria-label="Cerrar"
                    >
                        <X size={16} className="text-gray-500 dark:text-gray-400" />
                    </button>
                </div>

                {/* Lista de respuestas */}
                <div className="p-2 max-h-64 overflow-y-auto">
                    <div className="grid gap-1">
                        {quickReplies.map((reply) => (
                            <button
                                key={reply.id}
                                onClick={() => {
                                    onSelectReply(reply.text);
                                    onClose();
                                }}
                                className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-700/50 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg transition-colors"
                            >
                                <span className="text-lg">{reply.emoji}</span>
                                <span className="truncate">{reply.text}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Footer hint */}
                <div className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border-t border-gray-200 dark:border-gray-600">
                    <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                        Clic para insertar • Puedes editar antes de enviar
                    </p>
                </div>
            </div>
        </div>
    );
};

export default QuickReplies;
