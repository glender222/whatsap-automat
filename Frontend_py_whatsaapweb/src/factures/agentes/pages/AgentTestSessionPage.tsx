import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Bot, Loader2, Send, TerminalSquare } from 'lucide-react';
import { agentService, type AiAgent, type AgentRuntimeResult } from '../services/agentService';

type TestMessage = {
  id: string;
  role: 'user' | 'agent';
  body: string;
  result?: AgentRuntimeResult;
};

export default function AgentTestSessionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(() => {
    const value = Number(searchParams.get('agentId'));
    return Number.isInteger(value) && value > 0 ? value : null;
  });
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    agentService.list().then((items) => {
      if (!mounted) return;
      setAgents(items);
      if (!selectedAgentId && items[0]) setSelectedAgentId(items[0].id);
    }).catch((err) => {
      if (mounted) setError(err?.message || 'No se pudieron cargar agentes.');
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!selectedAgentId) return;
    const next = new URLSearchParams(searchParams);
    next.set('domain', 'gestion_web');
    next.set('agentId', String(selectedAgentId));
    setSearchParams(next, { replace: true });
  }, [selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId]
  );

  const sendTestMessage = async () => {
    if (!selectedAgentId || !message.trim() || loading) return;
    const text = message.trim();
    setMessage('');
    setError(null);
    setLoading(true);
    setMessages((current) => [...current, { id: `u-${Date.now()}`, role: 'user', body: text }]);
    try {
      const history = messages.map((item) => ({ fromMe: item.role === 'agent', body: item.body }));
      const result = await agentService.testSession(selectedAgentId, { message: text, history, domainKey: 'gestion_web' });
      setMessages((current) => [
        ...current,
        {
          id: `a-${Date.now()}`,
          role: 'agent',
          body: result.reply || '(sin respuesta final)',
          result,
        },
      ]);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo probar el agente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-6rem)] flex-col bg-slate-50 p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboard/ia/agentes" className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            <ArrowLeft className="h-4 w-4" />
            Volver a configuracion
          </Link>
          <h1 className="mt-2 text-2xl font-bold">Prueba de agente</h1>
        </div>
        <select
          value={selectedAgentId || ''}
          onChange={(event) => setSelectedAgentId(Number(event.target.value))}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
            <span className="font-semibold">{selectedAgent?.name || 'Agente'}</span>
            <span className="ml-2 text-slate-500">Sandbox: write/send devuelven dry_run.</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">Envia un mensaje para probar el runtime.</div>
            ) : (
              messages.map((item) => (
                <div key={item.id} className={`mb-3 flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-2xl rounded-lg px-3 py-2 text-sm shadow-sm ${item.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100'}`}>
                    <div className="whitespace-pre-wrap">{item.body}</div>
                    {item.result && (
                      <div className="mt-3 rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
                        <div className="mb-2 flex items-center gap-2 font-semibold">
                          <TerminalSquare className="h-4 w-4 text-emerald-600" />
                          Se ejecutaron {item.result.turn?.commandCount ?? item.result.commandCount ?? 0} comandos
                        </div>
                        {(item.result.turn?.commands || item.result.commands || []).map((command: any, index: number) => (
                          <div key={`${command.toolName || command.title}-${index}`} className="flex items-center justify-between border-t border-slate-100 py-1 dark:border-slate-800">
                            <span>{command.toolName || command.title}</span>
                            <span>{command.status}{command.output?.dryRun ? ' · dry_run' : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void sendTestMessage();
              }}
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
              placeholder="Mensaje de prueba"
            />
            <button
              type="button"
              onClick={sendTestMessage}
              disabled={loading || !selectedAgentId}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Enviar
            </button>
          </div>
          {error && <div className="border-t border-red-200 px-4 py-2 text-sm text-red-600">{error}</div>}
        </section>

        <aside className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <Bot className="h-5 w-5 text-emerald-600" />
            Contexto sandbox
          </div>
          <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <p>Dominio: gestion_web</p>
            <p>Agente: {selectedAgent?.name || '-'}</p>
            <p>Modo: {selectedAgent?.mode || '-'}</p>
            <p>Read tools consultan datos reales.</p>
            <p>Write/send tools se registran como dry_run.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
