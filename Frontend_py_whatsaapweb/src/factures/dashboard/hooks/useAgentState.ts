import { useCallback, useEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import SocketService from '../../../utils/socket';
import {
  agentStateAtom,
  pushAutoReplyAtom,
  pushBlockedAtom,
  pushOrderDetectedAtom,
  pushPaymentEventAtom,
  pushVoucherAtom,
  setHandoffTicketsAtom,
  setAgentTypingAtom,
  setCompanyModeChangedAtom,
  pushActivityEventAtom,
  upsertActivityTurnAtom,
  setAiSessionStatusAtom,
  setIaPauseStatusAtom,
  setPendingSuggestionAtom,
  type PendingSuggestion,
  type IaPauseStatus,
  type HandoffTicketSummary,
} from '../../../jotai/slices/agentStateAtom';
import { iaService } from '../services/iaService';

export function useAgentState() {
  const [state] = useAtom(agentStateAtom);
  const setPendingSuggestion = useSetAtom(setPendingSuggestionAtom);
  const setIaPauseStatus = useSetAtom(setIaPauseStatusAtom);
  const setHandoffTickets = useSetAtom(setHandoffTicketsAtom);
  const pushAutoReply = useSetAtom(pushAutoReplyAtom);
  const pushBlocked = useSetAtom(pushBlockedAtom);
  const pushOrderDetected = useSetAtom(pushOrderDetectedAtom);
  const pushVoucher = useSetAtom(pushVoucherAtom);
  const pushPaymentEvent = useSetAtom(pushPaymentEventAtom);
  const setAgentTyping = useSetAtom(setAgentTypingAtom);
  const setCompanyModeChanged = useSetAtom(setCompanyModeChangedAtom);
  const upsertActivityTurn = useSetAtom(upsertActivityTurnAtom);
  const pushActivityEvent = useSetAtom(pushActivityEventAtom);
  const setAiSessionStatus = useSetAtom(setAiSessionStatusAtom);

  const refreshHandoffTickets = useCallback(async () => {
    try {
      const data = await iaService.listHandoffTickets({ status: 'open', limit: 50 });
      setHandoffTickets(data.rows as HandoffTicketSummary[]);
    } catch (error) {
      console.error('Error cargando handoff tickets:', error);
    }
  }, [setHandoffTickets]);

  const refreshPauseStatus = useCallback(async (chatId: string) => {
    try {
      const status = await iaService.getPauseStatus(chatId);
      setIaPauseStatus({ chatId, status: status as IaPauseStatus });
    } catch (error) {
      console.error('Error cargando estado de pausa IA:', error);
    }
  }, [setIaPauseStatus]);

  useEffect(() => {
    const socket = SocketService.getInstance().connect();

    const onSuggestion = (payload: PendingSuggestion) => {
      setPendingSuggestion(payload);
    };
    const onAutoReply = (payload: { chatId: string; reply: string; confidence: number }) => {
      pushAutoReply(payload);
    };
    const onBlocked = (payload: { chatId: string; reason: string; topic: string | null }) => {
      pushBlocked(payload);
    };
    const onPaused = (payload: { chatId: string }) => {
      if (payload.chatId) refreshPauseStatus(payload.chatId);
    };
    const onResumed = (payload: { chatId: string }) => {
      if (payload.chatId) refreshPauseStatus(payload.chatId);
    };
    const onHandoff = () => {
      refreshHandoffTickets();
    };
    const onHandoffTaken = () => {
      refreshHandoffTickets();
    };
    const onHandoffClosed = () => {
      refreshHandoffTickets();
    };
    const onOrderDetected = (payload: { chatId: string; orderId: number; status: string; agentId?: number | null }) => {
      if (payload?.chatId && payload?.orderId) pushOrderDetected(payload);
    };
    const onTyping = (payload: { chatId: string; agentId: number }) => {
      if (payload?.chatId && payload?.agentId) setAgentTyping(payload);
    };
    const onVoucherCreated = (payload: { chatId?: string | null; voucherId: number }) => {
      if (payload?.voucherId) pushVoucher(payload);
    };
    const onPaymentCreated = (payload: { voucherId?: number; status?: string; chatId?: string | null }) => {
      pushPaymentEvent({ ...payload, event: 'payment-created' });
    };
    const onPaymentUpdated = (payload: { voucherId?: number; status?: string; chatId?: string | null }) => {
      pushPaymentEvent({ ...payload, event: 'payment-updated' });
    };
    const onPaymentValidated = (payload: { voucherId?: number; status?: string; chatId?: string | null }) => {
      pushPaymentEvent({ ...payload, event: 'payment-validated' });
    };
    const onCompanyModeChanged = () => {
      setCompanyModeChanged();
    };
    const onActivityTurn = (payload: any) => {
      if (!payload?.chatId || !payload?.turnId || !payload?.sessionId) return;
      upsertActivityTurn({
        chatId: payload.chatId,
        sessionId: Number(payload.sessionId),
        turnId: Number(payload.turnId),
        agentId: payload.agentId ?? null,
        status: payload.status || 'running',
        finalAction: payload.finalAction,
        finalReplyPreview: payload.finalReplyPreview,
        commandCount: payload.commandCount,
        inboundProviderMessageId: payload.inboundProviderMessageId || null,
      });
    };
    const onActivityEvent = (payload: any) => {
      if (!payload?.chatId || !payload?.turnId || !payload?.event) return;
      pushActivityEvent({
        chatId: payload.chatId,
        turnId: Number(payload.turnId),
        event: payload.event,
      });
    };
    const onSessionUpdated = (payload: any) => {
      if (!payload?.chatId || !payload?.sessionId || !payload?.status) return;
      setAiSessionStatus({
        chatId: payload.chatId,
        sessionId: Number(payload.sessionId),
        status: payload.status,
        agentId: payload.agentId ?? null,
        domainKey: payload.domainKey || 'gestion_web',
      });
    };

    socket.on('agent:suggestion', onSuggestion);
    socket.on('agent:auto_reply_sent', onAutoReply);
    socket.on('agent:blocked', onBlocked);
    socket.on('agent:order_detected', onOrderDetected);
    socket.on('agent:typing', onTyping);
    socket.on('agent:voucher_created', onVoucherCreated);
    socket.on('agent:paused', onPaused);
    socket.on('agent:resumed', onResumed);
    socket.on('agent:handoff', onHandoff);
    socket.on('agent:handoff_taken', onHandoffTaken);
    socket.on('agent:handoff_closed', onHandoffClosed);
    socket.on('payment-created', onPaymentCreated);
    socket.on('payment-updated', onPaymentUpdated);
    socket.on('payment-validated', onPaymentValidated);
    socket.on('company-mode-changed', onCompanyModeChanged);
    socket.on('agent:activity_turn', onActivityTurn);
    socket.on('agent:activity_event', onActivityEvent);
    socket.on('agent:session_updated', onSessionUpdated);

    return () => {
      socket.off('agent:suggestion', onSuggestion);
      socket.off('agent:auto_reply_sent', onAutoReply);
      socket.off('agent:blocked', onBlocked);
      socket.off('agent:order_detected', onOrderDetected);
      socket.off('agent:typing', onTyping);
      socket.off('agent:voucher_created', onVoucherCreated);
      socket.off('agent:paused', onPaused);
      socket.off('agent:resumed', onResumed);
      socket.off('agent:handoff', onHandoff);
      socket.off('agent:handoff_taken', onHandoffTaken);
      socket.off('agent:handoff_closed', onHandoffClosed);
      socket.off('payment-created', onPaymentCreated);
      socket.off('payment-updated', onPaymentUpdated);
      socket.off('payment-validated', onPaymentValidated);
      socket.off('company-mode-changed', onCompanyModeChanged);
      socket.off('agent:activity_turn', onActivityTurn);
      socket.off('agent:activity_event', onActivityEvent);
      socket.off('agent:session_updated', onSessionUpdated);
    };
  }, [
    setPendingSuggestion,
    pushAutoReply,
    pushBlocked,
    pushOrderDetected,
    pushVoucher,
    pushPaymentEvent,
    setAgentTyping,
    setCompanyModeChanged,
    upsertActivityTurn,
    pushActivityEvent,
    setAiSessionStatus,
    refreshPauseStatus,
    refreshHandoffTickets,
  ]);

  return {
    state,
    refreshHandoffTickets,
    refreshPauseStatus,
    clearPendingSuggestion: () => setPendingSuggestion(null),
  };
};
