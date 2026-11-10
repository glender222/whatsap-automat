import { useEffect, useRef, useState, type FormEvent } from 'react';
import { readSession } from '../../../shared/auth/session';
import GraphProblemNotice from './GraphProblemNotice';
import {
  cancelStudioEvaluation, executeStudioRevision, graphProblem, publishStudioRevision, readStudioExecution,
  saveStudioOpenAiCredential, saveStudioSuite, studioEvaluation,
  type ExecutionEvaluation, type GraphDraft, type GraphProblem, type StudioExecutionMode,
} from './agentGraphApi';

const control = 'w-full rounded-md border border-subtle bg-canvas px-3 py-2 text-sm';
const button = 'min-h-11 rounded-md border border-subtle px-3 text-sm font-semibold disabled:opacity-55';
type Attempt = { runId: string; suiteId: string };
type Case = { id: string; input: string; pattern: string };
const firstCase: Case = { id: 'case-1', input: '', pattern: '' };
const outcomes = { passed: 'Aprobado', assertion_failed: 'Aserción incumplida', uncertain: 'Resultado incierto', blocked: 'Bloqueado' };
const evaluating = 'Evaluando revisión…';

function readAttempt(key: string): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return typeof value?.runId === 'string' && typeof value.suiteId === 'string' ? value : null;
  } catch { return null; }
}

function attemptKey(draft: GraphDraft, mode: StudioExecutionMode) {
  return `studio-${mode}/${draft.tenantId}/${draft.graphId}/${draft.version}/${draft.specHash}`;
}

function providerTimeout(draft: GraphDraft, count = 1) {
  return Math.min(10000, Math.floor(Math.min(60000, draft.limits.maxDurationSeconds * 1000) / count));
}

export default function AgentGraphExecutionPanel({ draft }: { draft: GraphDraft }) {
  const [sessionGeneration] = useState(() => readSession().generation);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readStudioExecution>>>();
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [problem, setProblem] = useState<GraphProblem>();
  const [busy, setBusy] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [selected, setSelected] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [result, setResult] = useState<ExecutionEvaluation>();
  const [suiteName, setSuiteName] = useState('');
  const [cases, setCases] = useState([firstCase]);
  const [executionInput, setExecutionInput] = useState('');
  const [output, setOutput] = useState<string>();
  const [credentialSaved, setCredentialSaved] = useState(false);
  const action = useRef<AbortController>(null);
  const cancellation = useRef<AbortController>(null);
  const suiteSave = useRef<{ id: string; signature: string } | null>(null);
  const executionAttempt = useRef<{ attemptId: string; input: string } | null>(null);

  useEffect(() => {
    const request = new AbortController();
    readStudioExecution(draft, request.signal).then((value) => {
      if (request.signal.aborted) return;
      setStatus(value);
      setAttempt(value.mode ? readAttempt(attemptKey(draft, value.mode)) : null);
      setResult((current) => current?.mode === value.mode ? current : undefined);
    }).catch((cause: unknown) => {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos consultar la disponibilidad de ejecución.'));
    });
    return () => { request.abort(); action.current?.abort(); cancellation.current?.abort(); };
  }, [draft, statusAttempt]);

  async function perform(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (action.current || cancellation.current) return;
    const request = new AbortController();
    action.current = request;
    setBusy(label);
    setProblem(undefined);
    try { await work(request.signal); }
    catch (cause: unknown) {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos confirmar la operación.'));
    } finally {
      if (!request.signal.aborted) setBusy('');
      action.current = null;
    }
  }

  function saveSuite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const suite = { name: suiteName.trim(), scenarios: cases.map((item, index) => ({
      id: item.id, name: `Caso ${index + 1}`, mockInput: item.input, expectedTextPatterns: [item.pattern],
    })) };
    const signature = JSON.stringify(suite);
    if (suiteSave.current?.signature !== signature) suiteSave.current = { id: crypto.randomUUID(), signature };
    const { id } = suiteSave.current;
    void perform('Guardando suite…', async (signal) => {
      const saved = await saveStudioSuite(draft, { ...suite, id }, signal);
      if (signal.aborted) return;
      setStatus((value) => value && { ...value, suites: [saved, ...value.suites.filter((item) => item.id !== saved.id)].slice(0, 20) });
      setSelected(saved.id);
      setResult(undefined);
      setSuiteName('');
      setCases([firstCase]);
      suiteSave.current = null;
    });
  }

  function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = String(new FormData(form).get('apiKey') ?? '').trim();
    if (!key) return;
    setCredentialSaved(false);
    void perform('Guardando credencial…', async (signal) => {
      await saveStudioOpenAiCredential(key, sessionGeneration, signal);
      if (signal.aborted) return;
      form.reset();
      setCredentialSaved(true);
      const value = await readStudioExecution(draft, signal);
      if (!signal.aborted) setStatus(value);
    });
  }

  const suiteId = selected || attempt?.suiteId || status?.suites[0]?.id || '';
  const active = status?.active;
  const mode = status?.mode;
  const verification = mode === 'verification';
  const canDispatch = verification || status?.availability === 'ready';
  const suite = status?.suites.find(({ id }) => id === suiteId);
  const controlsBusy = Boolean(busy) || cancelling;
  const canCancel = attempt && (result ? result.status === 'running' : busy === evaluating);
  function evaluate() {
    if (!mode || !suite || !canDispatch || action.current || cancellation.current) return;
    const reusable = attempt?.suiteId === suiteId && (!result || result.status === 'running');
    const next = reusable ? attempt : { runId: crypto.randomUUID(), suiteId };
    setAttempt(next);
    setResult(undefined);
    try { sessionStorage.setItem(attemptKey(draft, mode), JSON.stringify(next)); } catch { /* Browser storage is optional. */ }
    void perform(evaluating, async (signal) => {
      const evaluation = await studioEvaluation(draft, next, mode, signal, verification ? 1000 : providerTimeout(draft, suite.scenarioCount));
      if (!signal.aborted) {
        setResult((current) => current?.status === 'cancelled' && evaluation.status === 'running' ? current : evaluation);
      }
    });
  }

  async function cancelEvaluation() {
    if (!mode || !attempt || cancellation.current) return;
    const request = new AbortController();
    cancellation.current = request;
    setCancelling(true);
    setProblem(undefined);
    try {
      const evaluation = await cancelStudioEvaluation(draft, attempt, mode, request.signal);
      if (!request.signal.aborted) {
        setResult((current) => current?.runId === evaluation.runId && current.scenarios.length > evaluation.scenarios.length
          ? current : evaluation);
      }
    } catch (cause: unknown) {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos confirmar la cancelación.'));
    } finally {
      cancellation.current = null;
      if (!request.signal.aborted) setCancelling(false);
    }
  }

  function publish() {
    if (!mode || !canDispatch || !result || result.mode !== mode) return;
    void perform('Publicando revisión…', async (signal) => {
      const publication = await publishStudioRevision(draft, result.runId, mode, signal);
      if (!signal.aborted) setStatus((value) => value && { ...value, active: publication });
    });
  }

  function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode || !canDispatch) return;
    const next = executionAttempt.current?.input === executionInput ? executionAttempt.current
      : { attemptId: crypto.randomUUID(), input: executionInput };
    executionAttempt.current = next;
    setOutput(undefined);
    void perform('Ejecutando prueba…', async (signal) => {
      const text = await executeStudioRevision(draft, {
        ...next, timeoutMs: verification ? 1000 : providerTimeout(draft),
      }, mode, signal);
      if (signal.aborted) return;
      setOutput(text);
      executionAttempt.current = null;
    });
  }

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-subtle bg-surface p-4" aria-labelledby="graph-publication-title">
      <h2 id="graph-publication-title" className="text-lg font-semibold">Evaluación y publicación</h2>
      {!status && !problem && <p role="status" className="text-sm text-secondary">Consultando disponibilidad…</p>}
      {problem && <GraphProblemNotice problem={problem} retry={!status ? () => {
        setProblem(undefined);
        setStatusAttempt((value) => value + 1);
      } : undefined} />}
      {status?.mode === null && <p className="text-sm text-secondary">Publicación no disponible en este entorno.</p>}
      {status && mode && <>
        <p className="text-sm text-secondary">{verification
          ? `Entorno de verificación · Revisión ${draft.version}. La publicación aquí solo habilita pruebas dentro de este entorno.`
          : `Proveedor OpenAI · Revisión ${draft.version}. El texto de prueba se envía al proveedor y consume cuota de la empresa.`}</p>
        {!canDispatch && <p role="status" className="text-sm text-secondary">{status.availability === 'paused'
          ? 'La ejecución con proveedor está pausada para esta empresa.'
          : 'Configura una credencial de OpenAI para esta empresa antes de evaluar o ejecutar.'}</p>}
        {!canDispatch && <button type="button" className={button} disabled={controlsBusy} onClick={() => {
          setProblem(undefined);
          setStatusAttempt((value) => value + 1);
        }}>Actualizar disponibilidad</button>}
        {mode === 'provider' && <details>
          <summary className="cursor-pointer text-sm font-semibold">Credencial de OpenAI</summary>
          <form className="mt-3 space-y-2" onSubmit={saveCredential}>
            <label className="block text-sm">Clave de API
              <input className={control} name="apiKey" type="password" autoComplete="new-password" required disabled={controlsBusy} />
            </label>
            <button className={button} disabled={controlsBusy}>Guardar credencial</button>
            {credentialSaved && <p role="status" className="text-sm text-secondary">Credencial guardada.</p>}
          </form>
        </details>}
        {!status.profile?.compatible && <p role="status" className="text-sm text-secondary">
          Esta revisión requiere un grafo de texto compatible con el modelo {status.profile?.model} y un presupuesto suficiente. <code>{status.profile?.issue}</code>
        </p>}
        <details>
          <summary className="cursor-pointer text-sm font-semibold">Crear suite de texto</summary>
          <form className="mt-3 space-y-3" onSubmit={saveSuite}>
            <label className="block text-sm">Nombre de la suite<input className={control} required disabled={controlsBusy} maxLength={120} value={suiteName} onChange={(event) => setSuiteName(event.target.value)} /></label>
            {cases.map((item, index) => <fieldset key={item.id} disabled={controlsBusy} className="space-y-2 rounded-md border border-subtle p-3">
              <legend className="text-sm font-semibold">Caso {index + 1}</legend>
              <label className="block text-sm">Entrada de prueba<textarea className={control} required maxLength={4096} value={item.input}
                onChange={(event) => setCases((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, input: event.target.value } : entry))} /></label>
              <label className="block text-sm">Patrón esperado<input className={control} required maxLength={256} value={item.pattern}
                onChange={(event) => setCases((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, pattern: event.target.value } : entry))} /></label>
              {cases.length > 1 && <button type="button" className={button} onClick={() => setCases((previous) => previous.filter((entry) => entry.id !== item.id))}>Quitar caso {index + 1}</button>}
            </fieldset>)}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={controlsBusy || cases.length >= 20}
                onClick={() => setCases((previous) => [...previous, { id: crypto.randomUUID(), input: '', pattern: '' }])}>Agregar caso</button>
              <button className={button} disabled={controlsBusy || !suiteName.trim()}>Guardar suite</button>
            </div>
          </form>
        </details>
        <label className="block text-sm">Suite para evaluar<select className={control} value={suiteId} disabled={controlsBusy} onChange={(event) => {
          setSelected(event.target.value);
          setResult(undefined);
        }}>
          {!status.suites.some((suite) => suite.id === suiteId) && <option value={suiteId}>Selecciona una suite disponible</option>}
          {status.suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name} · {suite.scenarioCount} casos</option>)}
        </select></label>
        <div className="flex flex-wrap gap-2">
          <button className={button} type="button" disabled={controlsBusy || !canDispatch || !status.profile?.compatible || !suite} onClick={evaluate}>Evaluar revisión</button>
          {attempt && <button className={button} type="button" disabled={controlsBusy} onClick={() => void perform('Consultando evaluación…', async (signal) => {
            const evaluation = await studioEvaluation(draft, attempt, mode, signal);
            if (!signal.aborted) {
              setSelected(evaluation.suiteId);
              setResult(evaluation);
            }
          })}>Consultar evaluación guardada</button>}
          {canCancel && (
            <button className={button} type="button" disabled={cancelling} aria-describedby="graph-cancel-description"
              onClick={() => void cancelEvaluation()}>{cancelling ? 'Cancelando…' : 'Cancelar evaluación'}</button>
          )}
        </div>
        {canCancel && (
          <p id="graph-cancel-description" className="text-sm text-secondary">La cancelación detiene los casos pendientes. El caso iniciado aún puede registrar un resultado.</p>
        )}
        {result && <div className="space-y-2 text-sm">
          <p role="status">{result.status === 'cancelled' ? 'Evaluación cancelada' : result.status === 'running' ? 'Evaluación en curso'
            : result.passed ? 'Evaluación aprobada' : 'Evaluación sin aprobación'}</p>
          {result.admittedScenarioId && result.status !== 'running' && (
            <p className="text-secondary">El último caso iniciado aún no tiene un resultado confirmado.</p>
          )}
          <ul className="list-disc break-words pl-5">{result.scenarios.map((scenario, index) => <li key={scenario.scenarioId}>Caso {index + 1} · {outcomes[scenario.outcome]}</li>)}</ul>
          <button className={button} type="button" disabled={controlsBusy || !canDispatch || result.status !== 'completed' || !result.passed || (active?.version ?? 0) >= draft.version} onClick={publish}>
            {verification ? 'Publicar en verificación' : 'Publicar para proveedor'}
          </button>
        </div>}
        {active && <p role="status" className="text-sm font-medium">{verification ? 'Revisión activa en verificación' : 'Revisión activa para proveedor'} · {active.version}</p>}
        {active?.version === draft.version && <form className="space-y-2" onSubmit={execute}>
          <label className="block text-sm">Entrada para la revisión publicada<textarea className={control} required maxLength={4096}
            value={executionInput} onChange={(event) => setExecutionInput(event.target.value)} /></label>
          <button className={button} disabled={controlsBusy || !canDispatch}>Ejecutar revisión publicada</button>
          {output !== undefined && <p role="status" className="whitespace-pre-wrap break-words text-sm">{output}</p>}
        </form>}
        {busy && !(busy === evaluating && result?.status === 'cancelled') && <p role="status" className="text-sm text-secondary">{busy}</p>}
      </>}
    </section>
  );
}
