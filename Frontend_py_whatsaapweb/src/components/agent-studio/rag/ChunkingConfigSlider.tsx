import React from 'react';

export interface ChunkingConfig {
  chunkSize: number;
  chunkOverlap: number;
  strategy: 'sliding_window' | 'paragraph' | 'sentence';
}

export interface ChunkingConfigSliderProps {
  config: ChunkingConfig;
  onChange: (next: ChunkingConfig) => void;
}

export const ChunkingConfigSlider: React.FC<ChunkingConfigSliderProps> = ({
  config,
  onChange,
}) => {
  const handleChunkSizeChange = (val: number) => {
    const nextOverlap = Math.min(config.chunkOverlap, Math.floor(val / 2));
    onChange({
      ...config,
      chunkSize: val,
      chunkOverlap: nextOverlap,
    });
  };

  const handleOverlapChange = (val: number) => {
    const clampedOverlap = Math.min(val, Math.floor(config.chunkSize * 0.5));
    onChange({
      ...config,
      chunkOverlap: clampedOverlap,
    });
  };

  return (
    <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 text-xs">
      <div>
        <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
          Estrategia de Fragmentación
        </label>
        <select
          value={config.strategy}
          onChange={(e) =>
            onChange({
              ...config,
              strategy: e.target.value as ChunkingConfig['strategy'],
            })
          }
          className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
        >
          <option value="sliding_window">Ventana Deslizante con Solapamiento</option>
          <option value="paragraph">Separación por Párrafos</option>
          <option value="sentence">Separación por Oraciones</option>
        </select>
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="font-semibold text-slate-700 dark:text-slate-300">
            Tamaño del Fragmento (Chunk Size): {config.chunkSize} tokens
          </label>
          <span className="text-[11px] text-slate-400 font-mono">128 - 2048</span>
        </div>
        <input
          type="range"
          min={128}
          max={2048}
          step={64}
          value={config.chunkSize}
          onChange={(e) => handleChunkSizeChange(parseInt(e.target.value, 10))}
          className="w-full accent-teal-600"
        />
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="font-semibold text-slate-700 dark:text-slate-300">
            Solapamiento (Overlap): {config.chunkOverlap} tokens
          </label>
          <span className="text-[11px] text-slate-400 font-mono">
            Máx {Math.floor(config.chunkSize * 0.5)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={256}
          step={16}
          value={config.chunkOverlap}
          onChange={(e) => handleOverlapChange(parseInt(e.target.value, 10))}
          className="w-full accent-teal-600"
        />
      </div>
    </div>
  );
};
