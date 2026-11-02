import React from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Coins,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { RegressionScorecard } from '../types';

export interface RegressionScorecardModalProps {
  isOpen: boolean;
  onClose: () => void;
  scorecard: RegressionScorecard | null;
}

export const RegressionScorecardModal: React.FC<RegressionScorecardModalProps> = ({
  isOpen,
  onClose,
  scorecard,
}) => {
  if (!isOpen || !scorecard) return null;

  const isPassRateMet = scorecard.passRatePercent >= 95.0;
  const isSecurityMet = scorecard.securityToolLeaks.length === 0;
  const isPublicationReady = isPassRateMet && isSecurityMet && !scorecard.regressionDetected;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scorecard-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl bg-white dark:bg-[#131B2E] rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div className="flex items-center space-x-2">
              <h2 id="scorecard-title" className="text-base font-bold text-slate-900 dark:text-slate-100">
                Scorecard de Regresión
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                {scorecard.suiteName}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Simulación determinista en sandbox sobre el grafo v{scorecard.graphVersion}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="Cerrar scorecard"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Readiness Banner */}
          <div
            className={`p-4 rounded-xl border flex items-start space-x-3 ${
              isPublicationReady
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-200'
            }`}
          >
            {isPublicationReady ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            )}
            <div className="text-xs">
              <h3 className="font-bold">
                {isPublicationReady
                  ? 'Agente Aprobado para Publicación'
                  : 'Publicación Bloqueada por Incumplimiento de Criterios'}
              </h3>
              <p className="mt-0.5 opacity-90">
                {isPublicationReady
                  ? 'Todos los escenarios de prueba cumplieron con el umbral mínimo del 95% y 0 fugas de seguridad.'
                  : `Se identificaron violaciones a los umbrales: ${
                      !isPassRateMet
                        ? `Pass rate (${scorecard.passRatePercent}%) inferior al 95%. `
                        : ''
                    }${
                      !isSecurityMet
                        ? `Fugas de seguridad detectadas (${scorecard.securityToolLeaks.join(', ')}). `
                        : ''
                    }`}
              </p>
            </div>
          </div>

          {/* Metric Cards Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Tasa de Éxito</span>
              <p
                className={`text-lg font-bold mt-1 ${
                  isPassRateMet ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'
                }`}
              >
                {scorecard.passRatePercent.toFixed(1)}%
              </p>
              <span className="text-[10px] text-slate-400">
                {scorecard.passedCount}/{scorecard.totalScenarios} escenarios
              </span>
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800">
              <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center space-x-1">
                <Clock className="w-3 h-3 text-slate-400" />
                <span>Latencia P95</span>
              </span>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-1">
                {scorecard.p95LatencyMs} ms
              </p>
              <span className="text-[10px] text-slate-400">P50: {scorecard.p50LatencyMs} ms</span>
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800">
              <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center space-x-1">
                <Coins className="w-3 h-3 text-slate-400" />
                <span>Costo Total</span>
              </span>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-1">
                ${(scorecard.totalCostMicroUsd / 1_000_000).toFixed(4)}
              </p>
              <span className="text-[10px] text-slate-400 font-mono">
                {scorecard.totalTokensUsed} tokens
              </span>
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800">
              <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center space-x-1">
                <ShieldAlert className="w-3 h-3 text-slate-400" />
                <span>Fugas Seguridad</span>
              </span>
              <p
                className={`text-lg font-bold mt-1 ${
                  scorecard.securityToolLeaks.length === 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600'
                }`}
              >
                {scorecard.securityToolLeaks.length}
              </p>
              <span className="text-[10px] text-slate-400">
                {scorecard.securityToolLeaks.length === 0 ? '0 detectadas' : 'Crítico'}
              </span>
            </div>
          </div>

          {/* Baseline Comparison */}
          {scorecard.baselineComparison && (
            <div className="p-4 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800 text-xs space-y-2">
              <h4 className="font-semibold text-slate-700 dark:text-slate-300">
                Comparativa vs Versión Publicada Anterior (v{scorecard.baselineVersion || 1})
              </h4>
              <div className="grid grid-cols-2 gap-3 text-slate-600 dark:text-slate-400">
                <div className="flex items-center space-x-1.5">
                  {scorecard.baselineComparison.passRateDelta >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-rose-500" />
                  )}
                  <span>
                    Delta Pass Rate:{' '}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {scorecard.baselineComparison.passRateDelta >= 0 ? '+' : ''}
                      {scorecard.baselineComparison.passRateDelta.toFixed(1)}%
                    </strong>
                  </span>
                </div>
                <div className="flex items-center space-x-1.5">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <span>
                    Delta P95:{' '}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {scorecard.baselineComparison.p95LatencyDeltaMs >= 0 ? '+' : ''}
                      {scorecard.baselineComparison.p95LatencyDeltaMs} ms
                    </strong>
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 py-4 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200"
          >
            Cerrar Scorecard
          </button>
        </div>
      </div>
    </div>
  );
};
