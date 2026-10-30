import React from 'react';

interface Etiqueta {
  nombre: string;
  check: string;
}

interface RangoTrabajoBotProps {
  etiquetas: Etiqueta[];
  etiquetasBot: string[];
}

const RangoTrabajoBot: React.FC<RangoTrabajoBotProps> = ({ etiquetas, etiquetasBot }) => (
  <div className="flex items-start gap-6 flex-wrap">
    <span className="text-sm font-semibold text-gray-700 mt-2">Rango de trabajo</span>
    <div className="flex flex-col items-center gap-2">
      <img src="../../../../../public/bot.jpg" alt="Bot" className="w-16 h-16" />
      <span className="text-xs text-gray-500 text-center max-w-[100px]">Solo etiquetas asociadas al bot</span>
    </div>
    <div className="flex flex-col gap-2 max-h-32 overflow-y-auto pr-1">
      {etiquetas.map(et => (
        <label key={et.nombre} className="flex items-center gap-2 cursor-pointer">
          <input 
            type="checkbox" 
            checked={etiquetasBot.includes(et.nombre)} 
            readOnly 
            className="w-4 h-4 rounded"
          />
          <span 
            className={`w-4 h-4 rounded ${et.check} border border-gray-300`}
          />
          <span className="text-sm text-gray-700 font-medium">{et.nombre}</span>
        </label>
      ))}
    </div>
  </div>
);

export default RangoTrabajoBot;
