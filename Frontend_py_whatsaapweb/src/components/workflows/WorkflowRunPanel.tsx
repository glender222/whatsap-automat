import { useEffect, useRef, useState } from 'react';
import { getWorkflowRun, workflowDate, workflowError, workflowStatus, type WorkflowRun } from './workflowApi';

const activeStatuses = new Set(['queued', 'running', 'waiting_timer', 'waiting_approval']);

export default function WorkflowRunPanel({ workflowId, runId, onObserved }: {
  workflowId: string; runId: string; onObserved: (run: WorkflowRun) => void;
}) {
  const [run, setRun] = useState<Awaited<ReturnType<typeof getWorkflowRun>>>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, []);

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const current = await getWorkflowRun(runId, request.signal);
        if (request.signal.aborted) return;
        if (current.workflowId !== workflowId) throw new Error('Esta ejecución pertenece a otro workflow.');
        setRun(current);
        onObserved(current);
        setError('');
        if (activeStatuses.has(current.status)) timer = setTimeout(read, 3000);
      } catch (cause) {
        if (!request.signal.aborted) setError(workflowError(cause, 'No pudimos actualizar la ejecución.'));
      }
    }
    void read();
    return () => { request.abort(); clearTimeout(timer); };
  }, [attempt, onObserved, runId, workflowId]);

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700" aria-labelledby="workflow-run-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="workflow-run-title" ref={title} tabIndex={-1} className="font-semibold">Detalle de ejecución</h3>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}
          className="min-h-11 rounded-md border border-gray-300 px-3 text-sm font-semibold dark:border-gray-600">Actualizar ejecución</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {!run && !error && <p role="status" className="text-sm">Cargando ejecución…</p>}
      {run && (
        <>
          <p role="status" className="text-sm font-medium">{workflowStatus(run.status)}</p>
          {run.status === 'queued' && <p className="text-sm">El evento está registrado y espera confirmación del worker.</p>}
          {run.status === 'waiting_timer' && <p className="text-sm">Temporal está esperando el temporizador de esta revisión.</p>}
          <dl className="grid gap-3 rounded-md bg-gray-50 p-3 text-sm dark:bg-gray-800 sm:grid-cols-2">
            <div className="min-w-0"><dt className="font-semibold">Identificador de ejecución</dt><dd className="break-all font-mono text-xs">{run.id}</dd></div>
            <div className="min-w-0"><dt className="font-semibold">Revisión vinculada</dt><dd className="break-all font-mono text-xs">{run.revisionId}</dd></div>
            <div><dt className="font-semibold">Registro</dt><dd>{workflowDate(run.startedAt)}</dd></div>
            {run.completedAt && <div><dt className="font-semibold">Finalización</dt><dd>{workflowDate(run.completedAt)}</dd></div>}
            <div><dt className="font-semibold">Pasos registrados</dt><dd>{run.stepCount}</dd></div>
            {run.currentStep && <div><dt className="font-semibold">Último paso</dt><dd className="break-all">{run.currentStep}</dd></div>}
            {run.temporalRunId && <div className="min-w-0"><dt className="font-semibold">Ejecución en Temporal</dt><dd className="break-all font-mono text-xs">{run.temporalRunId}</dd></div>}
            <div className="min-w-0"><dt className="font-semibold">Correlación</dt><dd className="break-all font-mono text-xs">{run.correlationId}</dd></div>
            {run.errorDetails?.code && <div><dt className="font-semibold">Código de error</dt><dd className="break-all">{run.errorDetails.code}</dd></div>}
          </dl>
        </>
      )}
    </section>
  );
}
