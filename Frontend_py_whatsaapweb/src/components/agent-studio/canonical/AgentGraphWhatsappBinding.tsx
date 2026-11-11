import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import GraphProblemNotice from './GraphProblemNotice';
import {
  bindStudioWhatsapp, graphPath, graphProblem, readStudioWhatsappBinding, studioLocation, unbindStudioWhatsapp,
  type GraphDraft, type GraphProblem, type StudioPublication, type StudioWhatsappBindingMode,
  type StudioWhatsappBindingSnapshot,
} from './agentGraphApi';

const control = 'rounded-md border border-subtle bg-canvas px-3 py-2 text-sm';
const button = 'min-h-11 rounded-md border border-subtle px-3 text-sm font-semibold disabled:opacity-55';
const modeNames = { suggest: 'Sugerencias', auto: 'Respuestas automáticas' };

interface Props {
  draft: GraphDraft;
  active: StudioPublication | null;
  available: boolean;
  sessionGeneration: number;
}

export default function AgentGraphWhatsappBinding({ draft, active, available, sessionGeneration }: Props) {
  const [params] = useSearchParams();
  const [snapshot, setSnapshot] = useState<StudioWhatsappBindingSnapshot>();
  const [mode, setMode] = useState<StudioWhatsappBindingMode>('suggest');
  const [refreshCount, setRefreshCount] = useState(0);
  const [error, setError] = useState<GraphProblem>();
  const [busy, setBusy] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const modeControl = useRef<HTMLSelectElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterChange = useRef(false);

  useEffect(() => {
    if (!busy && focusAfterChange.current) {
      focusAfterChange.current = false;
      (modeControl.current ?? heading.current)?.focus();
    }
  }, [busy, snapshot]);

  useEffect(() => {
    const request = new AbortController();
    readStudioWhatsappBinding({ signal: request.signal, sessionGeneration }).then((value) => {
      if (request.signal.aborted) return;
      setSnapshot(value);
      setMode(value.binding?.graphId === draft.graphId ? value.binding.mode : 'suggest');
    }).catch((cause: unknown) => {
      if (!request.signal.aborted) setError(graphProblem(cause, 'No pudimos consultar la revisión vinculada a WhatsApp.'));
    });
    return () => {
      request.abort();
      mutation.current?.abort();
    };
  }, [draft.graphId, refreshCount, sessionGeneration]);

  const current = snapshot?.binding;
  const bound = current?.graphId === draft.graphId && current.version === draft.version && current.specHash === draft.specHash;
  const published = available && active?.graphId === draft.graphId && active.version === draft.version && active.specHash === draft.specHash &&
    (active.profile !== 'catalog-router-v1' || active.whatsappBindingAllowed === true);

  function refresh() {
    setError(undefined);
    setSnapshot(undefined);
    setRefreshCount((value) => value + 1);
  }

  async function change(action: 'bind' | 'unbind') {
    if (!snapshot || error || mutation.current || (action === 'bind' && !published) || (action === 'unbind' && !bound)) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    const request = { signal: controller.signal, sessionGeneration };
    try {
      const next = action === 'bind'
        ? await bindStudioWhatsapp(draft, mode, snapshot, request, active ?? undefined)
        : await unbindStudioWhatsapp(snapshot, request);
      if (!controller.signal.aborted) {
        focusAfterChange.current = true;
        setSnapshot(next);
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(graphProblem(cause, 'No pudimos confirmar el cambio de la revisión vinculada a WhatsApp.'));
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change('bind');
  }

  return (
    <section aria-labelledby="studio-whatsapp-binding-title" className="space-y-3 rounded-lg border border-subtle p-3">
      <h3 ref={heading} tabIndex={-1} id="studio-whatsapp-binding-title" className="font-semibold">Revisión para WhatsApp</h3>
      {!snapshot && !error && <p role="status" className="text-sm text-secondary">Consultando vinculación…</p>}
      {error && <GraphProblemNotice problem={error} retry={refresh} />}
      {snapshot && (
        <p role="status" className="break-words text-sm text-secondary">
          {current
            ? <>Revisión vinculada · <Link className="font-medium underline"
              to={studioLocation(graphPath(current.graphId), { after: params.get('after'), version: current.version })}>
              {current.graphId} · {current.version}
            </Link> · {modeNames[current.mode]}{current.profile === 'catalog-router-v1' && ' · Catálogo'}</>
            : 'Sin revisión vinculada.'}
        </p>
      )}
      {snapshot && published && (
        <form className="space-y-2" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm">
            Modo de respuesta en WhatsApp
            <select ref={modeControl} className={control} value={mode} disabled={busy || Boolean(error)}
              onChange={(event) => setMode(event.target.value === 'auto' ? 'auto' : 'suggest')}>
              <option value="suggest">Sugerencias para el operador</option>
              <option value="auto">Respuestas automáticas</option>
            </select>
          </label>
          {mode === 'auto' && <p className="text-sm text-secondary">El envío automático depende del modo de la empresa y del estado de la conversación.</p>}
          <button className={button} disabled={busy || Boolean(error) || (bound && current.mode === mode)}>
            {bound ? 'Actualizar modo de WhatsApp' : current ? 'Vincular esta revisión en su lugar' : 'Vincular a WhatsApp'}
          </button>
        </form>
      )}
      {snapshot && bound && <button type="button" className={button} disabled={busy || Boolean(error)}
        onClick={() => void change('unbind')}>Desvincular de WhatsApp</button>}
      {busy && <p role="status" className="text-sm text-secondary">Guardando vinculación…</p>}
    </section>
  );
}
