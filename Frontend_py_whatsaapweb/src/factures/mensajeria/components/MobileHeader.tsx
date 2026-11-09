import { ArrowLeft, MessageSquareText } from 'lucide-react';
import type { Ref } from 'react';

interface ConversationHeaderProps {
  titleRef: Ref<HTMLHeadingElement>;
  selectedChatName: string;
  onBack: () => void;
}

export default function ConversationHeader({ titleRef, selectedChatName, onBack }: ConversationHeaderProps) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-subtle bg-surface px-3 sm:px-4">
      <button
        type="button"
        onClick={onBack}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-secondary hover:bg-canvas
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 md:hidden"
        aria-label="Volver a conversaciones"
      >
        <ArrowLeft size={19} aria-hidden="true" />
      </button>
      <MessageSquareText size={19} aria-hidden="true" className="hidden shrink-0 text-emerald-700 md:block" />
      <h2 ref={titleRef} tabIndex={-1} className="truncate font-semibold text-primary">{selectedChatName}</h2>
    </header>
  );
}
