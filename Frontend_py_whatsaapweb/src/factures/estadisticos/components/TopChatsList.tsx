// src/factures/estadisticos/components/TopChatsList.tsx

import React from 'react';
import { MessageCircle } from 'lucide-react';

interface TopChatsListProps {
  chats: Array<{
    chatId: string;
    name: string;
    messageCount: number;
  }>;
}

const TopChatsList: React.FC<TopChatsListProps> = ({ chats }) => {
  if (chats.length === 0) {
    return (
      <p className="text-center text-gray-500 dark:text-gray-400 py-8">
        No hay datos disponibles
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {chats.map((chat, index) => (
        <div
          key={chat.chatId}
          className="flex items-center gap-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-500 text-white font-bold text-sm">
            {index + 1}
          </div>
          <MessageCircle className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
              {chat.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {chat.chatId}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {chat.messageCount}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              mensajes
            </p>
          </div>
        </div>
      ))}
    </div>
  );
};

export default TopChatsList;
