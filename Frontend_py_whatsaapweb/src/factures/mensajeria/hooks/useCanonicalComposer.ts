import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import {
  deliveryLabel, messageProblem, readCanonicalHistory, resolveCanonicalChat, sendCanonicalAttachment, sendCanonicalText,
  takeConversationControl, type AttachmentIntent, type CanonicalConversation, type CanonicalMessage,
  type InboxActor, type TextIntent,
} from '../services/canonicalConversationApi';
import type { SelectedAttachment } from './useFileUpload';

type Intent = (TextIntent & { kind: 'text' }) | (AttachmentIntent & { kind: 'attachment' });
type Pending = Pick<Intent, 'conversationId' | 'key' | 'version' | 'kind'> & { phase: 'unconfirmed' | 'unknown' };
type Snapshot = { scope: string; requestNumber: number; inboundId?: string; conversation: CanonicalConversation | null; unresolved: boolean };
type RetryVerification = Pick<Snapshot, 'requestNumber' | 'inboundId'> & { key: string };
type Notice = { tone: 'status' | 'error' | 'unknown'; message: string };
// Keep the existing storage namespace so prior text attempts still reconcile.
const storageKey = (scope: string, id: string) => 'inbox-pending-text/' + scope.split('/', 2).join('/') + '/' + id;
const outcomeUncertain = 'La entrega sigue sin confirmar. Actualiza el estado para comprobar si llegó una confirmación de WhatsApp.';

function readPending(scope: string, id: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(scope, id)) ?? 'null') as Partial<Pending> | null;
    if (!value || typeof value.key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.key) ||
        value.conversationId !== id || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) ||
        (value.phase !== 'unconfirmed' && value.phase !== 'unknown') ||
        (value.kind !== undefined && value.kind !== 'text' && value.kind !== 'attachment')) return null;
    return { conversationId: id, key: value.key, version: value.version, phase: value.phase, kind: value.kind ?? 'text' };
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
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, SelectedAttachment | null>>({});
  const [busy, setBusy] = useState<Record<string, 'takeover' | 'send' | undefined>>({});
  const [retryable, setRetryable] = useState<Record<string, RetryVerification | undefined>>({});
  const [serverUnresolved, setServerUnresolved] = useState<Record<string, boolean>>({});
  const [closedWindow, setClosedWindow] = useState<Record<string, number>>({});
  const locks = useRef(new Set<string>());
  const exactIntents = useRef(new Map<string, Intent>());
  const savedIntents = useRef(new Map<string, Pending>());
  const attachmentUrls = useRef(new Set<string>());
  const [clock, setClock] = useState(Date.now);

  const setAttachmentDraft = useCallback((update: SetStateAction<SelectedAttachment | null>) => {
    if (!scope) return;
    setAttachmentDrafts((previous) => {
      const current = previous[scope] ?? null;
      const next = typeof update === 'function' ? update(current) : update;
      return next === current ? previous : { ...previous, [scope]: next };
    });
  }, [scope]);

  const selectAttachment = useCallback((file: File, type: SelectedAttachment['type'], forceDocument: boolean) => {
    if (!scope) return;
    const preview = URL.createObjectURL(file);
    attachmentUrls.current.add(preview);
    setAttachmentDraft({ file, preview, type, forceDocument });
  }, [scope, setAttachmentDraft]);

  useEffect(() => {
    const live = new Set(Object.values(attachmentDrafts).map((draft) => draft?.preview));
    for (const url of attachmentUrls.current) {
      if (live.has(url)) continue;
      URL.revokeObjectURL(url);
      attachmentUrls.current.delete(url);
    }
  }, [attachmentDrafts]);

  useEffect(() => {
    const urls = attachmentUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const acceptIntent = useCallback((target: string, chat: string, intent: Intent) => {
    if (intent.kind === 'text') {
      acceptDraft(chat, intent.text);
      return;
    }
    acceptDraft(chat, intent.caption);
    setAttachmentDrafts((previous) => {
      const draft = previous[target];
      return draft?.file === intent.file && draft.forceDocument === intent.forceDocument
        ? { ...previous, [target]: null } : previous;
    });
  }, [acceptDraft]);

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
        const unresolved = conversation?.hasUnresolvedDelivery === true || history.some((item) =>
          item.direction === 'outbound' && item.causedBy?.type === 'human' &&
          Boolean(item.clientRequestId) && item.deliveryState === 'unknown_delivery');
        setSnapshot({ scope, requestNumber, inboundId, conversation, unresolved });
        setLoadError(undefined);
        if (!conversation || locks.current.has(scope)) return;
        if (conversation.hasUnresolvedDelivery === false && !unresolved) {
          setServerUnresolved((previous) => previous[scope] ? { ...previous, [scope]: false } : previous);
        }
        const previous = savedIntents.current.get(scope) ?? readPending(scope, conversation.id);
        if (!previous || previous.conversationId !== conversation.id) return;
        const matchesAttempt = (item: CanonicalMessage) => item.direction === 'outbound' &&
          item.causedBy?.type === 'human' && item.clientRequestId === previous.key;
        const recorded = history.find(matchesAttempt) ??
          (await readCanonicalHistory(conversation, request.signal, previous.key)).find(matchesAttempt);
        if (request.signal.aborted || locks.current.has(scope)) return;
        if (recorded && ['provider_accepted', 'dispatched', 'delivered', 'read', 'failed'].includes(recorded.deliveryState)) {
          const intent = exactIntents.current.get(scope);
          if (intent?.key === previous.key && recorded.deliveryState !== 'failed') acceptIntent(scope, chatId, intent);
          exactIntents.current.delete(scope);
          remember(scope, conversation.id, null);
          setRetryable((value) => ({ ...value, [scope]: undefined }));
          showNotice(scope, { tone: recorded.deliveryState === 'failed' ? 'error' : 'status',
            message: deliveryLabel(recorded.deliveryState) ?? 'Resultado confirmado en el historial.' });
        } else if (recorded?.deliveryState === 'unknown_delivery') {
          remember(scope, conversation.id, { ...previous, phase: 'unknown' });
          setRetryable((value) => ({ ...value, [scope]: undefined }));
          showNotice(scope, { tone: 'unknown', message: outcomeUncertain });
        } else {
          remember(scope, conversation.id, previous);
          const canRetry = !recorded && previous.phase === 'unconfirmed' && exactIntents.current.get(scope)?.key === previous.key;
          setRetryable((value) => ({ ...value, [scope]: canRetry ? { key: previous.key, requestNumber, inboundId } : undefined }));
          if (!recorded && previous.kind === 'attachment' && !exactIntents.current.has(scope)) {
            showNotice(scope, { tone: 'unknown',
              message: 'El archivo original ya no está en memoria. Actualiza el estado para confirmar este intento.' });
          }
        }
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted) {
          setLoadError({ scope, message: cause instanceof Error && cause.name !== 'AxiosError'
            ? cause.message : 'No pudimos verificar el estado o el historial canónico de la conversación.' });
        }
      });
    return () => request.abort();
  }, [acceptIntent, actor, chatId, conversationId, inboundId, remember, requestNumber, scope, showNotice]);

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
  const canSendLegacyAttachment = Boolean(scope && fresh && !phase && !error && !unresolved && conversation === null);
  const canAttach = canSend || canSendLegacyAttachment;
  const retry = retryable[scope];
  const canRetryExact = Boolean(fresh && attempt?.phase === 'unconfirmed' && attempt.conversationId === conversation?.id &&
    retry?.key === attempt.key && retry.requestNumber === requestNumber && retry.inboundId === inboundId &&
    !error && !phase && !current?.unresolved && !serverUnresolved[scope] &&
    (attempt.kind !== 'attachment' || (verifiedConversation && windowOpen && owns)));

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

  async function execute(intent: Intent) {
    if (!chatId || !scope || locks.current.has(scope)) return;
    locks.current.add(scope);
    exactIntents.current.set(scope, intent);
    const meta = { conversationId: intent.conversationId, key: intent.key, version: intent.version, kind: intent.kind };
    remember(scope, intent.conversationId, { ...meta, phase: 'unconfirmed' });
    setRetryable((value) => ({ ...value, [scope]: undefined }));
    setBusy((value) => ({ ...value, [scope]: 'send' }));
    try {
      const result = await (intent.kind === 'attachment' ? sendCanonicalAttachment(intent) : sendCanonicalText(intent));
      if (result.kind === 'unknown') {
        remember(scope, intent.conversationId, { ...meta, phase: 'unknown' });
        showNotice(scope, { tone: 'unknown', message: outcomeUncertain });
        return;
      }
      remember(scope, intent.conversationId, null);
      exactIntents.current.delete(scope);
      if (result.kind === 'accepted') acceptIntent(scope, chatId, intent);
      showNotice(scope, { tone: result.kind === 'accepted' ? 'status' : 'error',
        message: result.kind === 'accepted' ? deliveryLabel(result.deliveryState) ?? 'Aceptado por WhatsApp'
          : 'WhatsApp rechazó el envío o venció la ventana de atención. El borrador se conservó.' });
    } catch (cause) {
      const problem = messageProblem(cause, intent.kind);
      if (problem.uncertain) {
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

  function intentFor(conversation: CanonicalConversation) {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { conversationId: conversation.id, version: conversation.stateVersion, key };
  }

  async function send(text: string) {
    if (!canSend || !conversation || expiresAt <= Date.now() || !text.trim() || locks.current.has(scope)) return;
    if (text.length > 4096 || text.includes('\u0000') || /[\uD800-\uDFFF]/u.test(text)) {
      showNotice(scope, { tone: 'error', message: 'El mensaje debe tener hasta 4096 caracteres válidos.' });
      return;
    }
    await execute({ ...intentFor(conversation), kind: 'text', text });
  }

  async function sendAttachment(caption: string) {
    const draft = attachmentDrafts[scope];
    if (!canSend || !conversation || expiresAt <= Date.now() || !draft || locks.current.has(scope)) return;
    if (caption.length > 1024 || caption.includes('\u0000') || /[\uD800-\uDFFF]/u.test(caption)) {
      showNotice(scope, { tone: 'error', message: 'El pie del archivo admite hasta 1024 caracteres válidos.' });
      return;
    }
    await execute({
      ...intentFor(conversation), file: draft.file, forceDocument: draft.forceDocument, kind: 'attachment', caption,
    });
  }

  async function retryExact() {
    const intent = exactIntents.current.get(scope);
    if (canRetryExact && intent && intent.key === attempt?.key &&
        (intent.kind !== 'attachment' || expiresAt > Date.now())) await execute(intent);
  }

  return {
    conversation, error, loading: Boolean(scope && !fresh && !error), phase, notice: notices[scope],
    windowOpen, owns, assignedElsewhere, unresolved, canSend, canAttach, canSendLegacyAttachment, canTakeover, canRetryExact,
    attachmentDraft: attachmentDrafts[scope] ?? null, attachmentPending: attempt?.kind === 'attachment',
    setAttachmentDraft, selectAttachment, takeover, refresh, send, sendAttachment, retryExact,
  };
}

export type CanonicalComposer = ReturnType<typeof useCanonicalComposer>;
