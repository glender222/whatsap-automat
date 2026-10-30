import React from "react";
import { createPortal } from "react-dom";

interface GlobalTransitionProps {
  show: boolean;
  message?: string;
  zIndex?: number;
}

const GlobalTransition: React.FC<GlobalTransitionProps> = ({ show, message = "Cargando...", zIndex = 100 }) => {
  if (!show) return null;
  return createPortal(
    <div className="fixed inset-0 bg-gradient-to-br from-gray-900 to-gray-800 flex flex-col items-center justify-center animate-fadeIn"
      style={{ zIndex }}>
      <div className="relative">
        <div className="w-20 h-20 border-4 border-gray-700/60 border-t-green-400 rounded-full animate-spin"></div>
      </div>
      <p className="text-green-200 text-xl font-semibold mt-6 animate-pulse">
        {message}
      </p>
    </div>,
    document.body
  );
};

export default GlobalTransition;
