import React, { useEffect, useRef } from 'react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

interface EmojiPickerProps {
  open: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

type EmojiMartEmoji = { native: string; [key: string]: any };

const pickerWidth = 380;

const EmojiPicker: React.FC<EmojiPickerProps> = ({ open, onSelect, onClose }) => {
  const pickerRef = useRef<HTMLDivElement>(null);

  // Cierra el picker si se hace click fuera del área
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="absolute bottom-12 left-0 z-30 flex items-start"
      style={{ width: `${pickerWidth}px` }}
    >
      <div
        ref={pickerRef}
        className="bg-white rounded-lg border border-gray-200 p-2"
        style={{
          boxShadow: '0 2px 16px rgba(0,0,0,0.15)',
          width: `${pickerWidth}px`
        }}
      >
        <Picker
          data={data}
          onEmojiSelect={(e: EmojiMartEmoji) => onSelect(e.native)}
          previewPosition="none"
          navPosition="top"
          searchPosition="top"
          emojiButtonSize={36}
          theme="light"
          width={pickerWidth}
        />
      </div>
    </div>
  );
};

export default EmojiPicker;