import React, { useEffect, useState } from 'react';
import Picker from '@emoji-mart/react';
import type { EmojiMartData } from '@emoji-mart/data';

interface EmojiPickerProps {
  id: string;
  open: boolean;
  onSelect: (emoji: string) => void;
}

type EmojiMartEmoji = { native: string };

const EmojiPicker: React.FC<EmojiPickerProps> = ({ id, open, onSelect }) => {
  const [data, setData] = useState<EmojiMartData>();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open || data) return;
    let active = true;
    // The package entry is native.json and its declarations expose only the data type.
    void import('@emoji-mart/data').then(
      (module) => { if (active) setData(module.default as unknown as EmojiMartData); },
      () => { if (active) setLoadFailed(true); },
    );
    return () => { active = false; };
  }, [data, open]);

  if (!open) return null;
  return (
    <div
      id={id}
      role="dialog"
      aria-label="Selector de emojis"
      className="absolute bottom-full left-2 right-2 z-30 mb-2 max-h-[50vh] max-w-[380px] overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg"
    >
      {data ? (
        <Picker
          data={data}
          onEmojiSelect={(e: EmojiMartEmoji) => onSelect(e.native)}
          previewPosition="none"
          navPosition="top"
          searchPosition="top"
          emojiButtonSize={36}
          theme="light"
          dynamicWidth
        />
      ) : (
        <p role={loadFailed ? 'alert' : 'status'} className="p-2 text-sm text-gray-700">
          {loadFailed ? 'No se pudieron cargar los emojis.' : 'Cargando emojis…'}
        </p>
      )}
    </div>
  );
};

export default EmojiPicker;
