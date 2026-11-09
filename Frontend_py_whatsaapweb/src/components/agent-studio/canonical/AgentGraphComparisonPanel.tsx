import { useEffect, useRef, useState } from 'react';
import GraphProblemNotice from './GraphProblemNotice';
import { compareGraphSpecs, getGraphDraft, graphProblem, type GraphDraft, type GraphProblem } from './agentGraphApi';

export default function AgentGraphComparisonPanel({ draft }: { draft: GraphDraft }) {
  const [previous, setPrevious] = useState<GraphDraft>();
  const [problem, setProblem] = useState<GraphProblem>();
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController>(null);
  const summary = useRef<HTMLHeadingElement>(null);

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (previous) summary.current?.focus();
  }, [previous]);

  async function compare() {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setProblem(undefined);
    try {
      const result = await getGraphDraft(draft.graphId, draft.version - 1, request.signal);
      if (!request.signal.aborted) setPrevious(result);
    } catch (cause) {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos cargar la revisión anterior.'));
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setLoading(false);
    }
  }

  const changes = previous ? compareGraphSpecs(previous, draft) : [];
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
      aria-labelledby="graph-comparison-title">
      <h2 id="graph-comparison-title" className="text-lg font-semibold">Comparación de revisiones</h2>
      {!previous && !problem && (
        <button type="button" onClick={() => void compare()} disabled={loading}
          className="min-h-11 rounded-md border border-gray-300 px-3 text-sm font-semibold disabled:opacity-55 dark:border-gray-600">
          Comparar con la revisión {draft.version - 1}
        </button>
      )}
      {loading && <p role="status" className="text-sm">Cargando revisión anterior…</p>}
      {problem && <GraphProblemNotice problem={problem} retry={() => void compare()} />}
      {previous && (
        <div className="min-w-0 space-y-3">
          <h3 ref={summary} tabIndex={-1} className="text-sm font-semibold">Revisión {previous.version} frente a revisión {draft.version}</h3>
          {changes.length === 0 && <p className="text-sm">Ambas revisiones tienen la misma especificación.</p>}
          {changes.map(({ key, label, before, after }) => (
            <details key={key} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{label}</summary>
              <div className="grid gap-3 sm:grid-cols-2">
                {[[`Revisión ${previous.version}`, before], [`Revisión ${draft.version}`, after]].map(([version, value]) => (
                  <div key={version} className="min-w-0 space-y-1">
                    <h4 className="text-xs font-semibold">{version}</h4>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 text-xs dark:bg-gray-800">{value}</pre>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
