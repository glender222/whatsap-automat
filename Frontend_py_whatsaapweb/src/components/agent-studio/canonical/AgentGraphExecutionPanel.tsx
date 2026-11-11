import { useEffect, useRef, useState, type FormEvent } from 'react';
import { readSession } from '../../../shared/auth/session';
import GraphProblemNotice from './GraphProblemNotice';
import AgentGraphWhatsappBinding from './AgentGraphWhatsappBinding';
import {
  cancelStudioEvaluation, executeStudioRevision, graphProblem, publishStudioRevision, readStudioExecution,
  saveStudioOpenAiCredential, saveStudioSuite, studioEvaluation,
  type ExecutionEvaluation, type GraphDraft, type GraphProblem, type StudioExecutionMode, type StudioExecutionProfileName,
} from './agentGraphApi';

const control = 'w-full rounded-md border border-subtle bg-canvas px-3 py-2 text-sm';
const button = 'min-h-11 rounded-md border border-subtle px-3 text-sm font-semibold disabled:opacity-55';
type Attempt = { runId: string; suiteId: string };
type ExecutionAttempt = { attemptId: string; timeoutMs: number };
type Case = { id: string; input: string; pattern: string; toolUse?: 'required' | 'forbidden' };
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

function executionAttemptKey(draft: GraphDraft, mode: StudioExecutionMode, userId: string) {
  return `studio-execution/${encodeURIComponent(userId)}/${attemptKey(draft, mode)}`;
}

function evaluationAttemptKey(draft: GraphDraft, mode: StudioExecutionMode, profile: StudioExecutionProfileName, userId: string | null) {
  if (profile === 'linear-text-v1') return attemptKey(draft, mode);
  return userId === null ? undefined : `studio-evaluation/${encodeURIComponent(userId)}/${profile}/${attemptKey(draft, mode)}`;
}

function readExecutionAttempt(key: string): ExecutionAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value?.attemptId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.attemptId) ||
        !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 30_000) return null;
    return { attemptId: value.attemptId, timeoutMs: value.timeoutMs };
  } catch { return null; }
}

function providerTimeout(draft: GraphDraft, count = 1) {
  return Math.min(10000, Math.floor(Math.min(60000, draft.limits.maxDurationSeconds * 1000) / count));
}

export default function AgentGraphExecutionPanel({ draft }: { draft: GraphDraft }) {
  const [{ sessionGeneration, userId }] = useState(() => {
    const session = readSession();
    return { sessionGeneration: session.generation, userId: session.user?.id ?? null };
  });
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
  const [pendingExecution, setPendingExecution] = useState<ExecutionAttempt | null>(null);
  const [output, setOutput] = useState<string>();
  const [credentialSaved, setCredentialSaved] = useState(false);
  const action = useRef<AbortController>(null);
  const cancellation = useRef<AbortController>(null);
  const suiteSave = useRef<{ id: string; signature: string } | null>(null);
  const executionField = useRef<HTMLTextAreaElement>(null);
  const lastCaseInput = useRef<HTMLTextAreaElement>(null);
  const focusNewCase = useRef(false);

  useEffect(() => {
    const request = new AbortController();
    readStudioExecution(draft, { signal: request.signal, sessionGeneration }).then((value) => {
      if (request.signal.aborted) return;
      setStatus(value);
      const profile = value.profile?.name ?? 'linear-text-v1';
      const key = value.mode && evaluationAttemptKey(draft, value.mode, profile, userId);
      setAttempt(key ? readAttempt(key) : null);
      setPendingExecution(value.mode && userId !== null ? readExecutionAttempt(executionAttemptKey(draft, value.mode, userId)) : null);
      setResult((current) => current?.mode === value.mode && (current?.profile ?? 'linear-text-v1') === profile ? current : undefined);
    }).catch((cause: unknown) => {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos consultar la disponibilidad de ejecución.'));
    });
    return () => { request.abort(); action.current?.abort(); cancellation.current?.abort(); };
  }, [draft, sessionGeneration, statusAttempt, userId]);

  useEffect(() => {
    if (focusNewCase.current) {
      lastCaseInput.current?.focus();
      focusNewCase.current = false;
    }
  }, [cases.length]);

  const forSession = (signal: AbortSignal) => ({ signal, sessionGeneration });

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
    if (!catalogSuiteValid) return;
    const suite = { name: suiteName.trim(), ...(catalogProfile && { profile: catalogProfile.name }), scenarios: cases.map((item, index) => ({
      id: item.id, name: `Caso ${index + 1}`, mockInput: item.input, expectedTextPatterns: [item.pattern],
      ...(catalogProfile && item.toolUse === 'required' && { expectedTools: ['catalog.search'] }),
      ...(catalogProfile && item.toolUse === 'forbidden' && { forbiddenTools: ['catalog.search'] }),
    })) };
    const signature = JSON.stringify(suite);
    if (suiteSave.current?.signature !== signature) suiteSave.current = { id: crypto.randomUUID(), signature };
    const { id } = suiteSave.current;
    void perform('Guardando suite…', async (signal) => {
      const saved = await saveStudioSuite(draft, { ...suite, id }, forSession(signal));
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
      await saveStudioOpenAiCredential(key, forSession(signal));
      if (signal.aborted) return;
      form.reset();
      setCredentialSaved(true);
      const value = await readStudioExecution(draft, forSession(signal));
      if (!signal.aborted) setStatus(value);
    });
  }

  const suiteId = selected || attempt?.suiteId || status?.suites[0]?.id || '';
  const active = status?.active;
  const mode = status?.mode;
  const verification = mode === 'verification';
  const profile = status?.profile?.name ?? 'linear-text-v1';
  const catalogProfile = status?.profile?.name === 'catalog-router-v1' ? status.profile : undefined;
  const publicationAllowed = !catalogProfile && status?.profile?.publicationAllowed !== false && result?.publicationAllowed !== false;
  const maxScenarios = catalogProfile?.maxScenarios ?? 20;
  const maxInputLength = catalogProfile?.maxInputLength ?? 4096;
  const catalogSuiteValid = !catalogProfile || (catalogProfile.compatible && cases.length <= maxScenarios &&
    cases.every((item) => item.toolUse && item.input.length <= maxInputLength &&
      JSON.stringify(item.input).length <= catalogProfile.maxSerializedInputLength));
  const canDispatch = verification || status?.availability === 'ready';
  const suite = status?.suites.find(({ id }) => id === suiteId);
  const controlsBusy = Boolean(busy) || cancelling;
  const canCancel = attempt && (result ? result.status === 'running' : busy === evaluating);
  function evaluate() {
    if (!mode || !suite || !status.profile?.compatible || !canDispatch || action.current || cancellation.current) return;
    const reusable = attempt?.suiteId === suiteId && (!result || result.status === 'running');
    const next = reusable ? attempt : { runId: crypto.randomUUID(), suiteId };
    setAttempt(next);
    setResult(undefined);
    const key = evaluationAttemptKey(draft, mode, profile, userId);
    try { if (key) sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Browser storage is optional. */ }
    void perform(evaluating, async (signal) => {
      const timeoutMs = catalogProfile?.minScenarioTimeoutMs ?? (verification ? 1000 : providerTimeout(draft, suite.scenarioCount));
      const evaluation = await studioEvaluation(draft, next, mode, forSession(signal), timeoutMs, profile);
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
      const evaluation = await cancelStudioEvaluation(draft, attempt, mode, forSession(request.signal), profile);
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
    if (!mode || !publicationAllowed || !canDispatch || !result || result.mode !== mode || result.status !== 'completed' || !result.passed) return;
    void perform('Publicando revisión…', async (signal) => {
      const publication = await publishStudioRevision(draft, result.runId, mode, forSession(signal));
      if (!signal.aborted) setStatus((value) => value && { ...value, active: publication });
    });
  }

  function savePendingExecution(next: ExecutionAttempt | null) {
    setPendingExecution(next);
    if (!mode || userId === null) return;
    const key = executionAttemptKey(draft, mode, userId);
    try {
      if (next) sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
    } catch { /* Browser storage is optional. */ }
  }

  function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode || catalogProfile || !canDispatch || !executionInput.trim()) return;
    void perform('Ejecutando prueba…', async (signal) => {
      const attempt = pendingExecution ?? { attemptId: crypto.randomUUID(), timeoutMs: verification ? 1000 : providerTimeout(draft) };
      savePendingExecution(attempt);
      setOutput(undefined);
      const text = await executeStudioRevision(draft, { ...attempt, input: executionInput }, mode, forSession(signal));
      if (signal.aborted) return;
      setOutput(text);
      savePendingExecution(null);
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
          {catalogProfile ? 'La evaluación de catálogo requiere el modo proveedor y presupuesto suficiente para cada caso.'
            : `Esta revisión requiere un grafo de texto compatible con el modelo ${status.profile?.model} y un presupuesto suficiente.`} <code>{status.profile?.issue}</code>
        </p>}
        {catalogProfile && <p className="text-sm text-secondary">La evaluación comprueba el texto y el uso de la búsqueda de catálogo. La publicación de este perfil aún no está disponible.</p>}
        {(!catalogProfile || catalogProfile.compatible) && <details>
          <summary className="cursor-pointer text-sm font-semibold">{catalogProfile ? 'Crear suite de catálogo' : 'Crear suite de texto'}</summary>
          <form className="mt-3 space-y-3" onSubmit={saveSuite}>
            <label className="block text-sm">Nombre de la suite<input className={control} required disabled={controlsBusy} maxLength={120} value={suiteName} onChange={(event) => setSuiteName(event.target.value)} /></label>
            {cases.map((item, index) => <fieldset key={item.id} disabled={controlsBusy} className="space-y-2 rounded-md border border-subtle p-3">
              <legend className="text-sm font-semibold">Caso {index + 1}</legend>
              <label className="block text-sm">Entrada de prueba<textarea ref={index === cases.length - 1 ? lastCaseInput : undefined}
                className={control} required maxLength={maxInputLength} value={item.input}
                onChange={(event) => setCases((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, input: event.target.value } : entry))} /></label>
              {catalogProfile && JSON.stringify(item.input).length > catalogProfile.maxSerializedInputLength &&
                <p role="status" className="text-sm text-secondary">La entrada ocupa demasiado espacio al enviarse. Acorta el texto.</p>}
              <label className="block text-sm">Patrón esperado<input className={control} required maxLength={256} value={item.pattern}
                onChange={(event) => setCases((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, pattern: event.target.value } : entry))} /></label>
              {catalogProfile && <label className="block text-sm">Búsqueda de catálogo<select className={control} required value={item.toolUse ?? ''}
                onChange={(event) => {
                  const toolUse = event.target.value === 'required' ? 'required' : event.target.value === 'forbidden' ? 'forbidden' : undefined;
                  setCases((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, toolUse } : entry));
                }}>
                <option value="">Selecciona el comportamiento esperado</option>
                <option value="required">Debe usarse</option>
                <option value="forbidden">No debe usarse</option>
              </select></label>}
              {cases.length > 1 && <button type="button" className={button} onClick={() => setCases((previous) => previous.filter((entry) => entry.id !== item.id))}>Quitar caso {index + 1}</button>}
            </fieldset>)}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={controlsBusy || cases.length >= maxScenarios}
                onClick={() => {
                  focusNewCase.current = true;
                  setCases((previous) => [...previous, { id: crypto.randomUUID(), input: '', pattern: '' }]);
                }}>Agregar caso</button>
              <button className={button} disabled={controlsBusy || !suiteName.trim() || !catalogSuiteValid}>Guardar suite</button>
            </div>
          </form>
        </details>}
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
            const evaluation = await studioEvaluation(draft, attempt, mode, forSession(signal), undefined, profile);
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
          <ul className="list-disc break-words pl-5">{result.scenarios.map((scenario, index) => <li key={scenario.scenarioId}>
            Caso {index + 1} · {outcomes[scenario.outcome]}
            {catalogProfile && scenario.executedTools && <p className="text-secondary">{scenario.executedTools.length
              ? 'Usó la búsqueda de catálogo.' : 'Sin herramientas ejecutadas.'}</p>}
          </li>)}</ul>
          {result.failureCode === 'CATALOG_EVIDENCE_INCOMPLETE' && <p className="text-secondary">No se confirmó la evidencia necesaria de una ronda.</p>}
          {publicationAllowed && <button className={button} type="button" disabled={controlsBusy || !canDispatch || result.status !== 'completed' || !result.passed || (active?.version ?? 0) >= draft.version} onClick={publish}>
            {verification ? 'Publicar en verificación' : 'Publicar para proveedor'}
          </button>}
        </div>}
        {active && <p role="status" className="text-sm font-medium">{verification ? 'Revisión activa en verificación' : 'Revisión activa para proveedor'} · {active.version}</p>}
        {mode === 'provider' && !catalogProfile && <AgentGraphWhatsappBinding draft={draft} active={active ?? null} sessionGeneration={sessionGeneration} />}
        {!catalogProfile && active?.version === draft.version && <form className="space-y-2" onSubmit={execute}>
          {pendingExecution && !controlsBusy && <div id="published-execution-recovery" className="space-y-1 text-sm text-secondary">
            <p role="status">Hay una ejecución sin confirmar.</p>
            <p>Vuelve a introducir el mismo texto para reintentar con el identificador anterior. Preparar una ejecución nueva puede generar otro consumo.</p>
          </div>}
          <label className="block text-sm">Entrada para la revisión publicada<textarea ref={executionField} className={control} required maxLength={4096}
            aria-describedby={pendingExecution && !controlsBusy ? 'published-execution-recovery' : undefined}
            disabled={controlsBusy}
            value={executionInput} onChange={(event) => setExecutionInput(event.target.value)} /></label>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={controlsBusy || !canDispatch}>
              {pendingExecution ? 'Reintentar la misma ejecución' : 'Ejecutar revisión publicada'}
            </button>
            {pendingExecution && <button type="button" className={button} disabled={controlsBusy} onClick={() => {
              savePendingExecution(null);
              setExecutionInput('');
              setProblem(undefined);
              executionField.current?.focus();
            }}>Preparar una ejecución nueva</button>}
          </div>
          {output !== undefined && <p role="status" className="whitespace-pre-wrap break-words text-sm">{output}</p>}
        </form>}
        {busy && !(busy === evaluating && result?.status === 'cancelled') && <p role="status" className="text-sm text-secondary">{busy}</p>}
      </>}
    </section>
  );
}
