import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deliveryLabel, messageProblem, readCanonicalHistory, resolveCanonicalChat, sendCanonicalText, takeConversationControl,
  type CanonicalConversation, type InboxActor, type TextIntent,
} from '../services/canonicalConversationApi';

type Pending = Omit<TextIntent, 'text'> & { phase: 'unconfirmed' | 'unknown' };
type Snapshot = { scope: string; requestNumber: number; inboundId?: string; conversation: CanonicalConversation | null; unresolved: boolean };
type Notice = { tone: 'status' | 'error' | 'unknown'; message: string };
const storageKey = (scope: string, id: string) => 'inbox-pending-text/' + scope.split('/', 2).join('/') + '/' + id;
const outcomeUncertain = 'La entrega sigue sin confirmar. Revisa el historial y concilia el envío en WhatsApp antes de continuar.';

function readPending(scope: string, id: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(scope, id)) ?? 'null') as Pending | null;
    return value && typeof value.key === 'string' && typeof value.conversationId === 'string' &&
      Number.isSafeInteger(value.version) && ['unconfirmed', 'unknown'].includes(value.phase) ? value : null;
  } catch {
    return null;
  }
}

function writePending(scope: string, id: string, pending: Pending | null) {
  try {
    if (pending) sessionStorage.setItem(storageKey(scope, id), JSON.stringify(pending));
    else sessionStorage.removeItem(storageKey(scope, id));
  } catch {
    // In-memory attempt tracking remains available when storage is restricted.
  }
}

export function useCanonicalComposer({
  chatId, conversationId, actor, inboundId, refreshHistory, acceptDraft,
}: {
  chatId: string | null;
  conversationId?: string;
  actor: InboxActor | null;
  inboundId?: string;
  refreshHistory: () => void;
  acceptDraft: (chatId: string, text: string) => void;
}) {
  const scope = chatId && actor ? `${actor.tenantId}/${actor.id}/${chatId}` : '';
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loadError, setLoadError] = useState<{ scope: string; message: string }>();
  const [requestNumber, setRequestNumber] = useState(0);
  const [pending, setPending] = useState<Record<string, Pending | null>>({});
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [proof, setProof] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, 'takeover' | 'send' | undefined>>({});
  const [retryable, setRetryable] = useState<Record<string, boolean>>({});
  const [serverUnresolved, setServerUnresolved] = useState<Record<string, boolean>>({});
  const [closedWindow, setClosedWindow] = useState<Record<string, number>>({});
  const locks = useRef(new Set<string>());
  const exactIntents = useRef(new Map<string, TextIntent>());
  const savedIntents = useRef(new Map<string, Pending>());
  const [clock, setClock] = useState(Date.now);

  const showNotice = useCallback((target: string, notice: Notice) => {
    setNotices((previous) => ({ ...previous, [target]: notice }));
  }, []);

  const remember = useCallback((target: string, id: string, attempt: Pending | null) => {
    if (attempt) savedIntents.current.set(target, attempt);
    else savedIntents.current.delete(target);
    writePending(target, id, attempt);
    setPending((previous) => ({ ...previous, [target]: attempt }));
  }, []);

  const refresh = useCallback(() => {
    setRequestNumber((previous) => previous + 1);
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!chatId || !actor || !scope) return;
    const request = new AbortController();
    resolveCanonicalChat(chatId, conversationId, actor, request.signal)
      .then(async (conversation) => {
        const history = conversation ? await readCanonicalHistory(conversation, request.signal) : [];
        if (request.signal.aborted) return;
        const unresolved = history.some((item) => item.direction === 'outbound' && item.causedBy?.type === 'human' &&
          Boolean(item.clientRequestId) && item.deliveryState === 'unknown_delivery');
        setSnapshot({ scope, requestNumber, inboundId, conversation, unresolved });
        setLoadError(undefined);
        if (!conversation || locks.current.has(scope)) return;
        const previous = savedIntents.current.get(scope) ?? readPending(scope, conversation.id);
        if (!previous || previous.conversationId !== conversation.id) return;
        const recorded = history.find((item) => item.direction === 'outbound' && item.clientRequestId === previous.key);
        if (recorded && ['provider_accepted', 'dispatched', 'delivered', 'read', 'failed'].includes(recorded.deliveryState)) {
          const text = exactIntents.current.get(scope)?.text;
          if (text && recorded.deliveryState !== 'failed') acceptDraft(chatId, text);
          exactIntents.current.delete(scope);
          remember(scope, conversation.id, null);
          setRetryable((value) => ({ ...value, [scope]: false }));
          showNotice(scope, { tone: recorded.deliveryState === 'failed' ? 'error' : 'status',
            message: deliveryLabel(recorded.deliveryState) ?? 'Resultado confirmado en el historial.' });
        } else if (recorded?.deliveryState === 'unknown_delivery') {
          remember(scope, conversation.id, { ...previous, phase: 'unknown' });
          setRetryable((value) => ({ ...value, [scope]: false }));
          showNotice(scope, { tone: 'unknown', message: outcomeUncertain });
        } else {
          remember(scope, conversation.id, previous);
        }
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted) {
          setLoadError({ scope, message: cause instanceof Error && cause.name !== 'AxiosError'
            ? cause.message : 'No pudimos verificar el estado o el historial canónico de la conversación.' });
        }
      });
    return () => request.abort();
  }, [acceptDraft, actor, chatId, conversationId, inboundId, remember, requestNumber, scope, showNotice]);

  const current = snapshot?.scope === scope ? snapshot : undefined;
  const fresh = current?.requestNumber === requestNumber && current?.inboundId === inboundId &&
    (!conversationId || current?.conversation?.id === conversationId);
  const conversation = current?.conversation;
  const error = loadError?.scope === scope ? loadError.message : undefined;
  const expiresAt = conversation?.serviceWindowExpiresAt ? Date.parse(conversation.serviceWindowExpiresAt) : 0;

  useEffect(() => {
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, expiresAt - Date.now() + 20));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const phase = busy[scope];
  const attempt = pending[scope];
  const unresolved = Boolean(attempt || current?.unresolved || serverUnresolved[scope]);
  const windowOpen = expiresAt > clock && closedWindow[scope] !== expiresAt;
  const verifiedConversation = Boolean(conversation?.channel === 'whatsapp-cloud' && conversation.status === 'open');
  const assignedElsewhere = Boolean(conversation?.assignedUserId && conversation.assignedUserId !== actor?.id);
  const owns = Boolean(conversation && proof[scope] === conversation.id &&
    conversation.assignedUserId === actor?.id && conversation.assignedAgentId === null && conversation.aiPaused);
  const canSend = Boolean(fresh && verifiedConversation && windowOpen && owns && !error && !phase && !unresolved);
  const canTakeover = Boolean(fresh && verifiedConversation && windowOpen && !assignedElsewhere && !owns && !error && !phase && !unresolved);
  const canAttach = Boolean(scope && fresh && !phase && !error && !unresolved &&
    (canSend || (current && conversation === null)));
  const canRetryExact = Boolean(fresh && attempt?.phase === 'unconfirmed' && attempt.conversationId === conversation?.id &&
    retryable[scope] && !error && !phase && !current?.unresolved && !serverUnresolved[scope]);

  async function takeover() {
    if (!canTakeover || !conversation || !actor || locks.current.has(scope) || expiresAt <= Date.now()) return;
    locks.current.add(scope);
    setBusy((value) => ({ ...value, [scope]: 'takeover' }));
    try {
      const claimed = await takeConversationControl(conversation, actor);
      setProof((value) => ({ ...value, [scope]: claimed.id }));
      setSnapshot((value) => value?.scope === scope ? { ...value, conversation: claimed } : value);
      showNotice(scope, { tone: 'status', message: 'Control confirmado para tu sesión.' });
    } catch (cause) {
      showNotice(scope, { tone: 'error', message: messageProblem(cause).message });
    } finally {
      locks.current.delete(scope);
      setBusy((value) => ({ ...value, [scope]: undefined }));
      refresh();
    }
  }

  async function execute(intent: TextIntent) {
    if (!chatId || !scope || locks.current.has(scope)) return;
    locks.current.add(scope);
    exactIntents.current.set(scope, intent);
    const meta = { conversationId: intent.conversationId, key: intent.key, version: intent.version };
    remember(scope, intent.conversationId, { ...meta, phase: 'unconfirmed' });
    setRetryable((value) => ({ ...value, [scope]: false }));
    setBusy((value) => ({ ...value, [scope]: 'send' }));
    try {
      const result = await sendCanonicalText(intent);
      if (result.kind === 'unknown') {
        remember(scope, intent.conversationId, { ...meta, phase: 'unknown' });
        showNotice(scope, { tone: 'unknown', message: outcomeUncertain });
        return;
      }
      remember(scope, intent.conversationId, null);
      exactIntents.current.delete(scope);
      if (result.kind === 'accepted') acceptDraft(chatId, intent.text);
      showNotice(scope, { tone: result.kind === 'accepted' ? 'status' : 'error',
        message: result.kind === 'accepted' ? deliveryLabel(result.deliveryState) ?? 'Aceptado por WhatsApp'
          : 'WhatsApp rechazó el envío o venció la ventana de atención. El borrador se conservó.' });
    } catch (cause) {
      const problem = messageProblem(cause);
      if (problem.uncertain) {
        setRetryable((value) => ({ ...value, [scope]: true }));
        showNotice(scope, { tone: 'unknown', message: problem.message });
      } else {
        remember(scope, intent.conversationId, null);
        exactIntents.current.delete(scope);
        if (problem.reason === 'HUMAN_TAKEOVER_REQUIRED') setProof((value) => ({ ...value, [scope]: '' }));
        if (problem.reason === 'DELIVERY_UNRESOLVED') {
          setServerUnresolved((value) => ({ ...value, [scope]: true }));
        }
        if (problem.reason === 'SERVICE_WINDOW_CLOSED') {
          setClosedWindow((value) => ({ ...value, [scope]: expiresAt }));
        }
        showNotice(scope, { tone: problem.reason === 'DELIVERY_UNRESOLVED' ? 'unknown' : 'error', message: problem.message });
      }
    } finally {
      locks.current.delete(scope);
      setBusy((value) => ({ ...value, [scope]: undefined }));
      refresh();
    }
  }

  async function send(text: string) {
    if (!canSend || !conversation || expiresAt <= Date.now() || !text.trim() || locks.current.has(scope)) return;
    if (text.length > 4096 || text.includes('\u0000') || /[\uD800-\uDFFF]/u.test(text)) {
      showNotice(scope, { tone: 'error', message: 'El mensaje debe tener hasta 4096 caracteres válidos.' });
      return;
    }
    const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    await execute({ conversationId: conversation.id, version: conversation.stateVersion, key, text });
  }

  async function retryExact() {
    const intent = exactIntents.current.get(scope);
    if (canRetryExact && intent && intent.key === attempt?.key) await execute(intent);
  }

  return {
    conversation, error, loading: Boolean(scope && !fresh && !error), phase, notice: notices[scope],
    windowOpen, owns, assignedElsewhere, unresolved, canSend, canAttach, canTakeover, canRetryExact,
    takeover, refresh, send, retryExact,
  };
}

export type CanonicalComposer = ReturnType<typeof useCanonicalComposer>;
