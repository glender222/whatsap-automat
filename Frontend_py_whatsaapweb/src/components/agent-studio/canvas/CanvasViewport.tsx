import React, { useRef, useCallback } from 'react';
import type { ViewportTransform } from '../types';

export interface CanvasViewportProps {
  viewport: ViewportTransform;
  onViewportChange: (next: ViewportTransform) => void;
  children: React.ReactNode;
  svgEdgesLayer: React.ReactNode;
  className?: string;
  isInteractive?: boolean;
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2.0;

export const CanvasViewport: React.FC<CanvasViewportProps> = ({
  viewport,
  onViewportChange,
  children,
  svgEdgesLayer,
  className = '',
  isInteractive = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanningRef = useRef(false);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isInteractive) return;
      const target = e.target as HTMLElement;
      if (
        target.classList.contains('agent-viewport-bg') ||
        target.classList.contains('agent-canvas-root') ||
        target.tagName.toLowerCase() === 'svg'
      ) {
        isPanningRef.current = true;
        lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      }
    },
    [isInteractive]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      onViewportChange({
        zoom: viewport.zoom,
        pan: {
          x: viewport.pan.x + dx,
          y: viewport.pan.y + dy,
        },
      });
    },
    [viewport, onViewportChange]
  );

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!isInteractive) return;
      e.preventDefault();

      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * zoomFactor));

      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        const effectiveFactor = targetZoom / viewport.zoom;
        const nextPanX = cursorX - (cursorX - viewport.pan.x) * effectiveFactor;
        const nextPanY = cursorY - (cursorY - viewport.pan.y) * effectiveFactor;

        onViewportChange({
          zoom: Number(targetZoom.toFixed(2)),
          pan: {
            x: Math.round(nextPanX),
            y: Math.round(nextPanY),
          },
        });
      } else {
        onViewportChange({
          zoom: Number(targetZoom.toFixed(2)),
          pan: viewport.pan,
        });
      }
    },
    [viewport, onViewportChange, isInteractive]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isInteractive) return;
      const step = e.shiftKey ? 80 : 40;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          onViewportChange({
            zoom: viewport.zoom,
            pan: { x: viewport.pan.x, y: viewport.pan.y + step },
          });
          break;
        case 'ArrowDown':
          e.preventDefault();
          onViewportChange({
            zoom: viewport.zoom,
            pan: { x: viewport.pan.x, y: viewport.pan.y - step },
          });
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onViewportChange({
            zoom: viewport.zoom,
            pan: { x: viewport.pan.x + step, y: viewport.pan.y },
          });
          break;
        case 'ArrowRight':
          e.preventDefault();
          onViewportChange({
            zoom: viewport.zoom,
            pan: { x: viewport.pan.x - step, y: viewport.pan.y },
          });
          break;
        case '+':
        case '=':
          e.preventDefault();
          onViewportChange({
            zoom: Number(Math.min(MAX_ZOOM, viewport.zoom * 1.15).toFixed(2)),
            pan: viewport.pan,
          });
          break;
        case '-':
        case '_':
          e.preventDefault();
          onViewportChange({
            zoom: Number(Math.max(MIN_ZOOM, viewport.zoom * 0.85).toFixed(2)),
            pan: viewport.pan,
          });
          break;
        case '0':
          e.preventDefault();
          onViewportChange({
            zoom: 1.0,
            pan: { x: 0, y: 0 },
          });
          break;
      }
    },
    [viewport, onViewportChange, isInteractive]
  );

  const transformStyle: React.CSSProperties = {
    transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})`,
    transformOrigin: '0 0',
  };

  return (
    <div
      ref={containerRef}
      className={`agent-canvas-root relative w-full h-full overflow-hidden select-none bg-slate-50 dark:bg-slate-950 focus:outline-none focus:ring-1 focus:ring-teal-500/50 ${className}`}
      role="region"
      aria-label="Lienzo de flujo de agente"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Dynamic Background Dot Grid */}
      <svg
        className="agent-viewport-bg absolute inset-0 w-full h-full pointer-events-none"
        aria-hidden="true"
      >
        <defs>
          <pattern
            id="agent-grid-dots"
            width={24 * viewport.zoom}
            height={24 * viewport.zoom}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${((viewport.pan.x % (24 * viewport.zoom)) + (24 * viewport.zoom)) % (24 * viewport.zoom)}, ${
              ((viewport.pan.y % (24 * viewport.zoom)) + (24 * viewport.zoom)) % (24 * viewport.zoom)
            })`}
          >
            <circle
              cx={2}
              cy={2}
              r={1.2}
              className="fill-slate-300 dark:fill-slate-700"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#agent-grid-dots)" />
      </svg>

      {/* Transformed Content Layer */}
      <div
        className="agent-viewport-layer absolute inset-0"
        style={transformStyle}
      >
        {/* SVG Bezier Edges */}
        <div className="absolute inset-0 pointer-events-none overflow-visible">
          {svgEdgesLayer}
        </div>

        {/* HTML Node Cards */}
        <div className="absolute inset-0 pointer-events-auto">
          {children}
        </div>
      </div>
    </div>
  );
};
