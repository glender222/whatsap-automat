import React, { useState } from 'react';
import {
  Search,
  Send,
  Paperclip,
  Smile,
  Bot,
  User,
  ShieldAlert,
  Clock,
  Sparkles,
  Check,
  RefreshCw,
  X,
  FileText,
  AlertTriangle,
  ChevronRight,
  Tag,
  Phone,
  Calendar,
  Layers,
} from 'lucide-react';
import {
  MOCK_CONVERSATIONS,
  type OmnichannelConversation,
  type OmnichannelMessage,
  type ChannelProvider,
  type AiSuggestionPayload,
} from './mock-contracts';

export const OmnichannelInboxSpec: React.FC = () => {
  const [conversations, setConversations] = useState<OmnichannelConversation[]>(MOCK_CONVERSATIONS);
  const [selectedChatId, setSelectedChatId] = useState<string>(MOCK_CONVERSATIONS[0].id);
  const [channelFilter, setChannelFilter] = useState<'all' | ChannelProvider>('all');
  const [composerText, setComposerText] = useState('');
  const [contextPanelOpen, setContextPanelOpen] = useState(true);

  // Active chat calculation
  const activeChat = conversations.find((c) => c.id === selectedChatId) || conversations[0];

  // AI Suggestion State
  const [activeSuggestion, setActiveSuggestion] = useState<AiSuggestionPayload | null>({
    suggestionId: 'sug-101',
    conversationId: 'chat-wsp-01',
    replyText: '¡Hola Carlos! Sí, disponemos de 15 unidades del modelo X listas para despacho inmediato en Lima. ¿Deseas que reservemos tu pedido?',
    confidenceScore: 0.94,
    suggestedAction: 'Consultó inventario (15 unidades en stock)',
    reasoningNotes: 'El cliente preguntó por disponibilidad del modelo X. Stock verificado mediante get_product_stock().',
    knowledgeSourcesUsed: [{ id: 'k-1', title: 'Catálogo de Productos 2026', type: 'catalog' }],
    expiresAt: Date.now() + 1000 * 60 * 10,
  });

  // Mock timeline messages
  const [messages, setMessages] = useState<OmnichannelMessage[]>([
    {
      id: 'msg-01',
      conversationId: 'chat-wsp-01',
      senderType: 'customer',
      senderName: 'Carlos Mendoza',
      body: 'Buenas tardes, ¿tienen disponibilidad del modelo X en stock?',
      timestamp: Date.now() - 1000 * 60 * 3,
      status: 'read',
      channel: 'whatsapp',
    },
  ]);

  // Handler for Takeover with CAS version increment
  const handleTakeover = () => {
    if (!activeChat) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeChat.id
          ? {
              ...c,
              status: 'open',
              assignedOperatorName: 'Ana Pérez (Tú)',
              stateVersion: c.stateVersion + 1, // CAS guard
            }
          : c
      )
    );
    setActiveSuggestion(null); // Invalidate pending AI suggestion upon human takeover
  };

  // Handler for Accept & Send AI Suggestion
  const handleAcceptSuggestion = () => {
    if (!activeSuggestion) return;
    const newMessage: OmnichannelMessage = {
      id: `msg-${Date.now()}`,
      conversationId: activeChat.id,
      senderType: 'operator',
      senderName: 'Ana Pérez',
      body: activeSuggestion.replyText,
      timestamp: Date.now(),
      status: 'sent',
      channel: activeChat.channel,
      isOptimistic: true,
      agentTraceId: 'trace-88941',
    };
    setMessages((prev) => [...prev, newMessage]);
    setActiveSuggestion(null);
  };

  // Handler for standard message send
  const handleSendMessage = () => {
    if (!composerText.trim()) return;
    const newMessage: OmnichannelMessage = {
      id: `msg-${Date.now()}`,
      conversationId: activeChat.id,
      senderType: 'operator',
      senderName: 'Ana Pérez',
      body: composerText.trim(),
      timestamp: Date.now(),
      status: 'sent',
      channel: activeChat.channel,
      isOptimistic: true,
    };
    setMessages((prev) => [...prev, newMessage]);
    setComposerText('');
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 dark:bg-[#0B0F19]">
      {/* ----------------- PANEL 1: BANDEJA (320px) ----------------- */}
      <section
        className="flex w-80 shrink-0 flex-col border-r bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800"
        aria-label="Lista de conversaciones"
      >
        {/* Channel Filters */}
        <div className="p-3 border-b border-inherit space-y-2">
          <div className="flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800 text-xs font-medium">
            {(['all', 'whatsapp', 'telegram', 'instagram'] as const).map((ch) => (
              <button
                key={ch}
                onClick={() => setChannelFilter(ch)}
                className={`flex-1 rounded py-1 capitalize transition-colors ${
                  channelFilter === ch
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400'
                }`}
              >
                {ch === 'all' ? 'Todos' : ch}
              </button>
            ))}
          </div>
          {/* Search Bar */}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar por nombre o teléfono..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>
        </div>

        {/* Conversation Items List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60" role="list">
          {conversations.map((chat) => {
            const isSelected = chat.id === selectedChatId;
            return (
              <div
                key={chat.id}
                role="listitem"
                onClick={() => setSelectedChatId(chat.id)}
                className={`flex cursor-pointer items-start gap-3 p-3 transition-colors ${
                  isSelected
                    ? 'bg-teal-50/70 dark:bg-teal-950/30 border-l-4 border-l-teal-600'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                }`}
              >
                <div className="relative shrink-0">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-200 text-slate-700 font-bold text-xs dark:bg-slate-700 dark:text-slate-200">
                    {chat.participant.name.slice(0, 2).toUpperCase()}
                  </div>
                  <span
                    className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white dark:border-slate-900 ${
                      chat.channel === 'whatsapp'
                        ? 'bg-emerald-500'
                        : chat.channel === 'telegram'
                        ? 'bg-sky-500'
                        : 'bg-pink-500'
                    }`}
                    title={`Canal: ${chat.channel}`}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {chat.participant.name}
                    </span>
                    <span className="text-[10px] text-slate-400 shrink-0">3 min</span>
                  </div>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {chat.lastMessagePreview}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {chat.tags.map((t) => (
                      <span
                        key={t.id}
                        className="rounded px-1.5 py-0.2 text-[9px] font-medium"
                        style={{ backgroundColor: `${t.color}20`, color: t.color }}
                      >
                        {t.name}
                      </span>
                    ))}
                    {chat.slaBreached && (
                      <span className="rounded bg-red-100 text-red-700 text-[9px] px-1 font-bold">
                        SLA Breach
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ----------------- PANEL 2: TIMELINE CENTRAL (Flex) ----------------- */}
      <section className="flex flex-1 flex-col overflow-hidden bg-white dark:bg-[#0E1526]" aria-label="Línea de tiempo">
        {/* Chat Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-4 border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {activeChat.participant.name}
                </h2>
                <span className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-600 dark:text-slate-300 capitalize">
                  {activeChat.channel}
                </span>
                <span className="text-[10px] text-slate-400">CAS v{activeChat.stateVersion}</span>
              </div>
              <p className="text-[11px] text-slate-400">{activeChat.participant.phoneNumber || activeChat.participant.username}</p>
            </div>
          </div>

          {/* Takeover & Actions */}
          <div className="flex items-center gap-2">
            {activeChat.status === 'ai_handling' && (
              <button
                type="button"
                onClick={handleTakeover}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
              >
                <User size={14} />
                <span>Tomar control (Pausar IA)</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setContextPanelOpen(!contextPanelOpen)}
              className="rounded p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Alternar panel de contexto"
            >
              <Layers size={16} />
            </button>
          </div>
        </header>

        {/* Messages Stream */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3" role="log">
          {messages.map((m) => {
            const isCustomer = m.senderType === 'customer';
            return (
              <div
                key={m.id}
                className={`flex flex-col ${isCustomer ? 'items-start' : 'items-end'}`}
              >
                <div
                  className={`max-w-md rounded-2xl px-4 py-2 text-xs shadow-sm ${
                    isCustomer
                      ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 rounded-bl-sm'
                      : 'bg-teal-600 text-white rounded-br-sm'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
                <div className="flex items-center gap-1 mt-1 text-[10px] text-slate-400">
                  <span>{m.senderName}</span>
                  <span>·</span>
                  <span>10:35 AM</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* AI Suggestion Banner */}
        {activeSuggestion && (
          <div className="border-t border-teal-200 bg-teal-50/70 p-3 dark:border-teal-900/60 dark:bg-teal-950/30">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300">
                  <Sparkles size={14} />
                  <span>Sugerencia IA ({Math.round(activeSuggestion.confidenceScore * 100)}% confianza)</span>
                </div>
                <p className="mt-1 text-xs text-slate-800 dark:text-slate-200">
                  {activeSuggestion.replyText}
                </p>
                <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                  Justificación: {activeSuggestion.reasoningNotes}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveSuggestion(null)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Cerrar sugerencia"
              >
                <X size={14} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleAcceptSuggestion}
                className="flex items-center gap-1 rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700"
              >
                <Check size={12} />
                <span>Aceptar y Enviar</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposerText(activeSuggestion.replyText);
                  setActiveSuggestion(null);
                }}
                className="rounded border border-teal-300 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-teal-700 dark:text-teal-300 hover:bg-teal-50"
              >
                Editar en composer
              </button>
            </div>
          </div>
        )}

        {/* 24-Hour Service Window Warning (WhatsApp) */}
        {!activeChat.is24hWindowActive && activeChat.channel === 'whatsapp' && (
          <div className="border-t border-amber-200 bg-amber-50 p-2 text-center text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle size={14} className="inline mr-1" />
            Ventana de 24h expirada. Solo puedes reabrir esta conversación enviando una plantilla aprobada por Meta.
          </div>
        )}

        {/* Composer */}
        <div className="border-t p-3 border-slate-200 dark:border-slate-800">
          <div className="flex items-end gap-2">
            <button
              type="button"
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600"
              title="Adjuntar archivo o imagen"
              aria-label="Adjuntar archivo o imagen"
            >
              <Paperclip size={18} />
            </button>
            <div className="flex-1">
              <textarea
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Escribe un mensaje o presiona Enter para enviar..."
                className="w-full resize-none rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500 max-h-24"
                rows={2}
              />
            </div>
            <button
              type="button"
              onClick={handleSendMessage}
              disabled={!composerText.trim()}
              className="rounded-lg bg-teal-600 p-2 text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
              aria-label="Enviar mensaje"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </section>

      {/* ----------------- PANEL 3: CONTEXTO E IDENTIDAD (300px) ----------------- */}
      {contextPanelOpen && (
        <aside
          className="flex w-72 shrink-0 flex-col border-l bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800 p-4 space-y-4 overflow-y-auto"
          aria-label="Información del cliente y contexto"
        >
          <div>
            <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider">
              Cliente
            </h3>
            <div className="mt-2 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-slate-700 font-bold dark:bg-slate-700 dark:text-slate-200">
                {activeChat.participant.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {activeChat.participant.name}
                </p>
                <p className="text-xs text-slate-500">{activeChat.participant.phoneNumber}</p>
              </div>
            </div>
          </div>

          <div className="border-t pt-3 border-inherit">
            <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">Etiquetas</h4>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {activeChat.tags.map((t) => (
                <span
                  key={t.id}
                  className="rounded px-2 py-0.5 text-xs font-medium"
                  style={{ backgroundColor: `${t.color}20`, color: t.color }}
                >
                  {t.name}
                </span>
              ))}
            </div>
          </div>

          <div className="border-t pt-3 border-inherit">
            <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              Actividad del Agente
            </h4>
            <div className="mt-2 space-y-2 text-xs text-slate-500">
              <div className="rounded border border-slate-200 dark:border-slate-800 p-2 bg-slate-50 dark:bg-slate-900/40">
                <span className="font-semibold text-teal-600">get_product_stock()</span>
                <p className="text-[11px] mt-0.5">Modelo X: 15 u. disponibles</p>
              </div>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
};
