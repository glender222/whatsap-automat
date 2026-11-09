import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FlaskConical } from 'lucide-react';
import GraphProblemNotice from './GraphProblemNotice';
import {
  fixtureInputLimit, fixtureStepLimit, graphFixtureProblem, nodeKinds, simulateGraphDraft,
  type GraphDraft, type GraphFixtureResult, type GraphProblem,
} from './agentGraphApi';

const resultLabels: Record<GraphFixtureResult['finalState'], string> = {
  completed: 'Prueba completada',
  handed_off: 'Derivación simulada',
  failed: 'Prueba con fallos',
};

function failureLabel(reason: string) {
  const budget = /^Execution exceeded maximum budget of (\d+) steps$/.exec(reason);
  if (budget) return `La prueba alcanzó el límite de ${budget[1]} ${budget[1] === '1' ? 'paso' : 'pasos'}.`;
  if (reason === 'Simulation ended without reaching an end or handoff node') return 'La prueba terminó antes de llegar a un nodo de fin o de derivación.';
  return reason;
}

export default function AgentGraphFixturePanel({ draft }: { draft: GraphDraft }) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<GraphFixtureResult>();
  const [problem, setProblem] = useState<GraphProblem>();
  const [running, setRunning] = useState(false);
  const requestRef = useRef<AbortController>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const overStepLimit = draft.limits.maxSteps > fixtureStepLimit;

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (result) resultHeading.current?.focus();
  }, [result]);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current || !input.trim() || input.length > fixtureInputLimit || overStepLimit) return;
    const request = new AbortController();
    requestRef.current = request;
    setRunning(true);
    setProblem(undefined);
    setResult(undefined);
    try {
      const response = await simulateGraphDraft(draft, input, request.signal);
      if (!request.signal.aborted) setResult(response);
    } catch (cause) {
      if (!request.signal.aborted) setProblem(graphFixtureProblem(cause));
    } finally {
      if (!request.signal.aborted) setRunning(false);
      requestRef.current = null;
    }
  }

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="graph-fixture-title">
      <header>
        <h2 id="graph-fixture-title" className="flex items-center gap-2 text-lg font-semibold">
          <FlaskConical size={18} aria-hidden="true" className="text-emerald-700 dark:text-emerald-300" /> Simulación de prueba
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">La prueba usa la revisión {draft.version} guardada. Sigue la primera conexión de cada nodo según el orden guardado.</p>
      </header>
      <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">
        <p>La ruta se mantiene aunque las conexiones tengan condiciones o prioridades. Las respuestas, herramientas y aprobaciones se generan como datos de prueba.</p>
        <p className="mt-1">Límite de la revisión {draft.limits.maxSteps} {draft.limits.maxSteps === 1 ? 'paso' : 'pasos'}. El simulador admite hasta {fixtureStepLimit}.</p>
      </div>
      {overStepLimit && <p role="status" className="text-sm text-amber-800 dark:text-amber-200">Crea una revisión con un límite de hasta {fixtureStepLimit} pasos para usar el simulador.</p>}
      <form className="space-y-3" onSubmit={run}>
        <div>
          <label htmlFor="graph-fixture-input" className="block text-sm font-semibold">Mensaje de prueba</label>
          <textarea id="graph-fixture-input" className="mt-1 w-full rounded-md border border-gray-300 bg-white p-3 text-sm dark:border-gray-600 dark:bg-gray-900"
            rows={3} maxLength={fixtureInputLimit} value={input} readOnly={running} aria-describedby="graph-fixture-input-length"
            onChange={(event) => { setInput(event.target.value); setResult(undefined); setProblem(undefined); }} />
          <p id="graph-fixture-input-length" className="text-xs text-gray-600 dark:text-gray-300">{input.length} de {fixtureInputLimit} caracteres</p>
        </div>
        <button type="submit" disabled={running || !input.trim() || overStepLimit}
          className="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-55">
          Simular revisión {draft.version}
        </button>
      </form>
      {running && <p role="status" className="text-sm">Ejecutando la prueba…</p>}
      {problem && <GraphProblemNotice problem={problem} />}
      {result && (
        <div className={result.finalState === 'failed'
          ? 'min-w-0 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950'
          : 'min-w-0 space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950'}>
          <header className="space-y-1">
            <h3 ref={resultHeading} tabIndex={-1} className="text-base font-semibold">{resultLabels[result.finalState]}</h3>
            <p className="text-sm">Revisión {result.graphVersion} · {result.totalSteps} {result.totalSteps === 1 ? 'paso recorrido' : 'pasos recorridos'}</p>
            <p className="break-all text-xs">Huella <code>{result.specHash}</code></p>
          </header>
          {result.failureReasons.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">{result.failureReasons.map((reason, index) => (
              <li key={index} className="break-words">{failureLabel(reason)}</li>
            ))}</ul>
          )}
          {result.executedNodes.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold">Recorrido de nodos</h4>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {result.executedNodes.map((node, index) => (
                  <li key={`${node.nodeId}-${index}`} className="min-w-0 break-words">
                    <code className="break-all">{node.nodeId}</code> · {nodeKinds[node.kind]}
                    {Object.keys(node.output).length > 0 && (
                      <details>
                        <summary className="w-fit cursor-pointer rounded py-1 text-xs font-semibold underline">Ver salida de prueba</summary>
                        <pre className="my-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 text-xs dark:bg-gray-900">{JSON.stringify(node.output, null, 2)}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {result.simulatedMessages.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold">Mensajes de prueba</h4>
              <ul className="space-y-1 text-sm">{result.simulatedMessages.map((message, index) => (
                <li key={index} className="whitespace-pre-wrap break-words">{message.text}</li>
              ))}</ul>
            </div>
          )}
          {result.approvalsTriggered.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold">Aprobaciones de prueba</h4>
              <ul className="list-disc space-y-1 pl-5 text-sm">{result.approvalsTriggered.map((approval, index) => (
                <li key={`${approval.nodeId}-${index}`} className="break-all">{approval.nodeId}</li>
              ))}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
