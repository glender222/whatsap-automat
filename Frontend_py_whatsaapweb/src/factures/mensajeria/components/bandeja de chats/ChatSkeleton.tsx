import React from 'react';

/**
 * Skeleton loading para un chat individual
 * Se muestra mientras los chats están cargando
 */
const ChatSkeleton: React.FC = () => {
    return (
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-3 animate-pulse">
            {/* Avatar skeleton */}
            <div className="w-[38px] h-[38px] rounded-full bg-gray-200 dark:bg-gray-600 flex-shrink-0" />

            <div className="flex-1 min-w-0">
                {/* Nombre skeleton */}
                <div className="flex items-center justify-between mb-2">
                    <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-3/4" />
                    <div className="h-3 bg-gray-200 dark:bg-gray-600 rounded w-10 ml-2" />
                </div>

                {/* Preview skeleton */}
                <div className="h-3 bg-gray-200 dark:bg-gray-600 rounded w-1/2" />
            </div>
        </div>
    );
};

/**
 * Múltiples skeletons para mostrar durante la carga inicial
 */
export const ChatSkeletonList: React.FC<{ count?: number }> = ({ count = 5 }) => {
    return (
        <>
            {[...Array(count)].map((_, i) => (
                <ChatSkeleton key={`skeleton-${i}`} />
            ))}
        </>
    );
};

export default ChatSkeleton;
