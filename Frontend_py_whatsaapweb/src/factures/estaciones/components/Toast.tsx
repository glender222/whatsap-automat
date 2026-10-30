import React from 'react';
import type { ToastProps } from '../types/Station';

export function Toast({ message, onClose }: ToastProps) {
  React.useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed top-6 right-6 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white px-6 py-4 rounded-xl shadow-2xl z-[9999] flex items-center gap-3 animate-slide-in">
      <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
      <span className="font-medium">{message}</span>
    </div>
  );
}