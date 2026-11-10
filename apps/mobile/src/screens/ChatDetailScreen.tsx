import React, { useCallback, useEffect, useRef, useState } from 'react';
import { uuid } from 'expo';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import Paperclip from 'lucide-react-native/icons/paperclip';
import Send from 'lucide-react-native/icons/send';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { apiClient, MobileApiError, type MobileChatOwnership, type MobileMessage, type MobileSendCommand } from '../services/apiClient';
import { isAttachmentId, safeAttachmentName } from '../services/attachmentData';
import { canUseAttachmentCaption, MAX_ATTACHMENT_CAPTION_LENGTH, type OutboundAttachment } from '../services/outboundAttachment';
import { pickAttachment } from '../services/pickAttachment';
import { useSession } from '../services/sessionContext';
import { useRefreshOnFocus } from '../services/useRefreshOnFocus';
import { TakeoverButton } from '../components/TakeoverButton';
import { DARK_THEME as colors, type RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'ChatDetail'>;

function mergeMessages(current: MobileMessage[], fresh: MobileMessage[]) {
  const messages = new Map(current.map((item) => [item.id, item]));
  for (const item of fresh) messages.set(item.id, item);
  return [...messages.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function isUnresolvedReply(message: MobileMessage) {
  return message.fromMe && Boolean(message.clientRequestId) && message.status === 'unknown_delivery';
}

const deliveryLabels: Record<string, string> = {
  sent: 'Enviado',
  dispatched: 'Enviado',
  provider_accepted: 'Aceptado por WhatsApp',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Falló',
  cancelled: 'Cancelado',
  unknown_delivery: 'Entrega sin confirmar',
};

const sendRejectionLabels: Record<string, string> = {
  CONVERSATION_VERSION_CHANGED: 'La conversación cambió. Revisa su estado antes de volver a enviar.',
  HUMAN_TAKEOVER_REQUIRED: 'Toma el control de la conversación antes de enviar.',
  SERVICE_WINDOW_CLOSED: 'La ventana de atención cerró. Usa una plantilla aprobada desde el espacio web.',
  ATTACHMENT_SIZE_INVALID: 'El adjunto está vacío o supera el tamaño permitido.',
  ATTACHMENT_TYPE_UNSUPPORTED: 'El servidor no admite el formato del adjunto.',
  ATTACHMENT_CAPTION_UNSUPPORTED: 'Los audios se envían sin pie de archivo.',
  ATTACHMENT_REJECTED: 'WhatsApp rechazó el adjunto.',
  ATTACHMENT_VIDEO_INVALID: 'No se pudo preparar el video para WhatsApp.',
};

const acceptedNotice = 'WhatsApp aceptó el mensaje.';
const failedNotice = 'El servidor confirmó que el mensaje no se envió.';

export function ChatDetailScreen({ route, navigation }: Props) {
  const { session, isSessionActive, pendingReplies, rememberReply, forgetReply } = useSession();
  const [chat, setChat] = useState(route.params.chat);
  const [messages, setMessages] = useState<MobileMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [selectedAttachment, setSelectedAttachment] = useState<OutboundAttachment>();
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [canLoadOlder, setCanLoadOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [serverDeliveryBlocked, setServerDeliveryBlocked] = useState<boolean | null>(null);
  const [hasActiveSession, setHasActiveSession] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sendNotice, setSendNotice] = useState('');
  const [ownershipNotice, setOwnershipNotice] = useState('');
  const listRef = useRef<FlatList<MobileMessage>>(null);
  const lastReadMessage = useRef<string | null>(null);
  const initialPageLoaded = useRef(false);
  const loadedHistoryId = useRef<string | null>(null);
  const olderCursor = useRef<string | null>(null);
  const sendInFlight = useRef(false);
  const picker = useRef<AbortController | null>(null);

  const { id: chatId, conversationId, stateVersion, assignedUserId } = chat;
  const pending = pendingReplies.get(chatId);
  const pendingKey = pending?.key;
  const updateOwnership = useCallback((ownership: MobileChatOwnership) => {
    const { conversationId, stateVersion, assignedUserId, aiPaused } = ownership;
    if (stateVersion == null || !Number.isInteger(stateVersion)) return;
    setChat((current) => {
      if (conversationId != null && String(conversationId) !== String(current.conversationId)) {
        return { ...current, conversationId, stateVersion, assignedUserId, aiPaused };
      }
      if (current.stateVersion != null && stateVersion < current.stateVersion) return current;
      return { ...current, stateVersion, assignedUserId, aiPaused };
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const [messageResult, sessionResult] = await Promise.allSettled([
        conversationId != null
          ? apiClient.listConversationMessages(conversationId)
          : apiClient.listMessages(chatId).then((messages) => ({ messages, nextCursor: null })),
        apiClient.getChatSessionStatus(chatId),
      ]);
      if (!isSessionActive()) return;
      const active = sessionResult.status === 'fulfilled' && typeof sessionResult.value.hasActiveSession === 'boolean'
        ? sessionResult.value.hasActiveSession : null;
      if (sessionResult.status === 'fulfilled') updateOwnership(sessionResult.value);
      setHasActiveSession(active);
      if (messageResult.status === 'rejected') throw messageResult.reason;
      const { messages: page, nextCursor } = messageResult.value;
      const historyId = conversationId != null ? String(conversationId) : null;
      const replaceHistory = !initialPageLoaded.current || loadedHistoryId.current !== historyId;
      if (replaceHistory) {
        initialPageLoaded.current = true;
        loadedHistoryId.current = historyId;
        lastReadMessage.current = null;
        olderCursor.current = nextCursor;
        setCanLoadOlder(conversationId != null ? Boolean(nextCursor) : page.length === 50);
      }
      let fresh = page;
      if (conversationId != null && pendingKey && !page.some((message) => message.clientRequestId === pendingKey)) {
        const exact = await apiClient.listConversationMessages(conversationId, undefined, pendingKey).catch(() => null);
        if (!isSessionActive()) return;
        const match = exact?.messages.find((message) => message.clientRequestId === pendingKey && message.fromMe);
        if (match) fresh = [...page, match];
      }
      setMessages((current) => mergeMessages(replaceHistory ? [] : current, fresh));
      const historyBlocked = fresh.some(isUnresolvedReply);
      const sessionBlocked = sessionResult.status === 'fulfilled' ? sessionResult.value.hasUnresolvedDelivery : undefined;
      if (typeof sessionBlocked === 'boolean') setServerDeliveryBlocked(sessionBlocked || historyBlocked);
      else if (historyBlocked) setServerDeliveryBlocked(null);
      setLoadError('');
      const latestInbound = page.reduce<MobileMessage | undefined>((latest, item) =>
        !item.fromMe && (!latest || item.timestamp > latest.timestamp) ? item : latest, undefined)?.id;
      if (latestInbound && lastReadMessage.current !== latestInbound) {
        lastReadMessage.current = latestInbound;
        void apiClient.markAsRead(chatId).catch(() => {
          if (lastReadMessage.current === latestInbound) lastReadMessage.current = null;
        });
      }
    } catch {
      setLoadError('No se pudo actualizar la conversación. Revisa tu conexión.');
    } finally {
      setLoading(false);
    }
  }, [chatId, conversationId, isSessionActive, pendingKey, updateOwnership]);
  const refresh = useRefreshOnFocus(load);

  const cancelPicker = useCallback(() => {
    picker.current?.abort();
    picker.current = null;
    setPicking(false);
  }, []);
  useFocusEffect(useCallback(() => cancelPicker, [cancelPicker]));

  const restoreDraft = useCallback((command: MobileSendCommand) => {
    setDraft(command.text);
    setSelectedAttachment('attachment' in command ? command.attachment : undefined);
  }, []);

  useEffect(() => {
    if (!pending || sending) return;
    const status = messages.find((item) => item.clientRequestId === pending.key)?.status;
    if (!status) return;
    if (['dispatched', 'provider_accepted', 'delivered', 'read'].includes(status)) {
      forgetReply(chatId, pending);
      setDraft('');
      setSelectedAttachment(undefined);
      setSendNotice(acceptedNotice);
    } else if (status === 'failed' || status === 'cancelled') {
      forgetReply(chatId, pending);
      restoreDraft(pending);
      setSendNotice(failedNotice);
    }
  }, [chatId, forgetReply, messages, pending, restoreDraft, sending]);

  async function refreshChat() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  async function loadOlder() {
    if (loadingOlder || !messages[0]?.timestamp) return;
    setLoadingOlder(true);
    try {
      if (conversationId != null && olderCursor.current) {
        const page = await apiClient.listConversationMessages(conversationId, olderCursor.current);
        olderCursor.current = page.nextCursor;
        setMessages((current) => mergeMessages(current, page.messages));
        setCanLoadOlder(Boolean(page.nextCursor));
      } else if (conversationId == null) {
        const page = await apiClient.listMessages(chatId, messages[0].timestamp);
        setMessages((current) => mergeMessages(current, page));
        setCanLoadOlder(page.length === 50);
      }
      setLoadError('');
    } catch {
      setLoadError('No se pudieron cargar los mensajes anteriores.');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function reloadOwnership(error: MobileApiError) {
    const { currentVersion, ownerId, ownerType } = error.metadata ?? {};
    if (typeof currentVersion === 'number' && Number.isInteger(currentVersion)) {
      const assignedUserId = ownerType === 'human' && (typeof ownerId === 'string' || typeof ownerId === 'number') ? ownerId : null;
      updateOwnership({ stateVersion: currentVersion, assignedUserId, aiPaused: null });
    }
    try {
      const status = await apiClient.getChatSessionStatus(chatId);
      if (status.stateVersion != null) {
        updateOwnership(status);
        return;
      }
    } catch {
      // The conflict response can still supply the server's current version.
    }
    if (typeof currentVersion !== 'number' || !Number.isInteger(currentVersion)) {
      setChat((current) => ({ ...current, stateVersion: null }));
      setLoadError('Vuelve a abrir la conversación desde la bandeja para actualizar la asignación.');
    }
  }

  const hasUnresolvedDelivery = serverDeliveryBlocked ?? messages.some(isUnresolvedReply);
  const ownsConversation = assignedUserId != null && String(assignedUserId) === session.userId;
  const canEdit = hasActiveSession === true && !loadError && !pending && !hasUnresolvedDelivery && !sending;
  const hasControl = ownsConversation && conversationId != null && stateVersion != null;
  const activeAttachment = pending && 'attachment' in pending ? pending.attachment : selectedAttachment;
  const captionError = activeAttachment && (!canUseAttachmentCaption(activeAttachment.mimeType) && draft.trim()
    ? 'Borra el texto para enviar este audio.'
    : draft.trim().length > MAX_ATTACHMENT_CAPTION_LENGTH ? 'El pie del archivo admite hasta 1024 caracteres.' : '');
  const canSend = canEdit && hasControl && !picking && !captionError && Boolean(draft.trim() || selectedAttachment);
  const canPick = canEdit && hasControl && !picking;

  async function selectFile() {
    if (!canPick || picker.current || !isSessionActive()) return;
    const controller = new AbortController();
    picker.current = controller;
    setPicking(true);
    setPickError('');
    try {
      const file = await pickAttachment(controller.signal);
      if (file && picker.current === controller && isSessionActive()) setSelectedAttachment(file);
    } catch (error) {
      if (picker.current === controller && isSessionActive()) {
        setPickError(error instanceof Error ? error.message : 'No se pudo leer el archivo seleccionado.');
      }
    } finally {
      if (picker.current === controller) {
        picker.current = null;
        setPicking(false);
      }
    }
  }

  async function send(command: MobileSendCommand) {
    if (sendInFlight.current || !isSessionActive()) return;
    sendInFlight.current = true;
    rememberReply(chatId, command);
    setSending(true);
    setSendNotice('');
    try {
      const outcome = await apiClient.sendMessage(command);
      if (!isSessionActive()) return;
      if (outcome === 'accepted') {
        forgetReply(chatId, command);
        setDraft('');
        setSelectedAttachment(undefined);
        setSendNotice(acceptedNotice);
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      } else if (outcome === 'failed') {
        forgetReply(chatId, command);
        restoreDraft(command);
        setSendNotice(failedNotice);
      }
    } catch (error) {
      if (!isSessionActive()) return;
      if (error instanceof MobileApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        const reason = error.metadata?.reasonCode;
        if (reason === 'DELIVERY_UNRESOLVED') setServerDeliveryBlocked(true);
        forgetReply(chatId, command);
        restoreDraft(command);
        setSendNotice(typeof reason === 'string' && sendRejectionLabels[reason]
          ? sendRejectionLabels[reason]
          : 'El servidor rechazó el envío. Revisa la conversación antes de volver a intentarlo.');
      }
    } finally {
      await refresh(true);
      sendInFlight.current = false;
      setSending(false);
    }
  }

  function sendDraft() {
    if (!canSend || conversationId == null || stateVersion == null || sendInFlight.current) return;
    const command = { conversationId, expectedVersion: stateVersion, key: uuid.v4(), text: draft.trim() };
    void send(selectedAttachment ? { ...command, attachment: selectedAttachment } : command);
  }

  const title = chat.name?.trim() || chatId;
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Volver a la bandeja" onPress={navigation.goBack}>
          <ArrowLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerContent}>
          <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{title}</Text>
          <Text style={styles.secondary}>Conversación</Text>
        </View>
        <TakeoverButton
          chat={chat}
          userId={session.userId}
          onUpdated={updateOwnership}
          onConflict={reloadOwnership}
          onNotice={setOwnershipNotice}
        />
      </View>

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {loadError ? <Text accessibilityRole="alert" style={styles.notice}>{loadError}</Text> : null}
        {ownershipNotice ? <Text accessibilityRole="alert" style={styles.notice}>{ownershipNotice}</Text> : null}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.timeline}
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 0 }}
          onContentSizeChange={() => {
            if (loading || loadingOlder || !initialPageLoaded.current) return;
            if (listRef.current && messages.length <= 50) listRef.current.scrollToEnd({ animated: false });
          }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshChat} tintColor={colors.accent} colors={[colors.accent]} />}
          ListHeaderComponent={canLoadOlder ? (
            <Pressable accessibilityRole="button" style={styles.loadOlder} onPress={() => void loadOlder()} disabled={loadingOlder}>
              <Text style={styles.action}>{loadingOlder ? 'Cargando…' : 'Cargar mensajes anteriores'}</Text>
            </Pressable>
          ) : undefined}
          ListEmptyComponent={
            <View style={styles.empty}>
              {loading ? <ActivityIndicator color={colors.accent} /> : null}
              <Text style={styles.secondary}>{loading ? 'Cargando mensajes…' : loadError ? 'Desliza para volver a intentar.' : 'Aún no hay mensajes.'}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const timestamp = item.timestamp < 1e12 ? item.timestamp * 1000 : item.timestamp;
            const time = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            return (
              <View style={[styles.bubble, item.fromMe && styles.outbound]}>
                {item.body || !item.attachments?.length ? (
                  <Text style={styles.message}>{item.body || (item.type && item.type !== 'text' ? 'Archivo adjunto' : 'Mensaje sin texto')}</Text>
                ) : null}
                {isAttachmentId(String(conversationId)) && isAttachmentId(item.id) ? item.attachments?.map((attachment) => {
                  const filename = safeAttachmentName(attachment.filename, attachment.mimeType);
                  return (
                    <Pressable key={attachment.id} accessibilityRole="button" accessibilityLabel={`Ver adjunto ${filename}`}
                      style={styles.attachment} onPress={() => navigation.navigate('AttachmentDetail', {
                        conversationId: String(conversationId), messageId: item.id, attachment,
                      })}>
                      <Text numberOfLines={2} style={styles.attachmentName}>{filename}</Text>
                    </Pressable>
                  );
                }) : null}
                <Text style={styles.secondary}>{[time, item.fromMe && item.status ? deliveryLabels[item.status] : ''].filter(Boolean).join(' · ')}</Text>
              </View>
            );
          }}
        />

        {hasActiveSession === false ? (
          <Text style={styles.notice} accessibilityRole="alert">
            La ventana de atención cerró. Usa una plantilla aprobada desde el espacio web.
          </Text>
        ) : null}
        {!loading && hasActiveSession === null ? (
          <Text style={styles.notice} accessibilityRole="alert">No se pudo verificar la ventana de atención. Desliza para actualizar antes de enviar.</Text>
        ) : null}
        {hasActiveSession && !ownsConversation && !pending && !hasUnresolvedDelivery ? (
          <Text style={styles.notice}>Toma el control de la conversación para enviar una respuesta.</Text>
        ) : null}
        {!sending && (pending || hasUnresolvedDelivery) ? (
          <View>
            <Text style={styles.notice} accessibilityRole="alert">La entrega del último envío sigue sin confirmar. Los envíos nuevos están en pausa.</Text>
            <Pressable accessibilityRole="button" style={styles.loadOlder} onPress={() => void refreshChat()} disabled={refreshing}>
              <Text style={styles.action}>Actualizar conversación</Text>
            </Pressable>
            {pending && !hasUnresolvedDelivery ? (
              <Pressable accessibilityRole="button" style={styles.loadOlder} onPress={() => void send(pending)}>
                <Text style={styles.action}>Reintentar el mismo envío</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {sendNotice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{sendNotice}</Text> : null}
        {pickError ? <Text accessibilityRole="alert" style={styles.notice}>{pickError}</Text> : null}
        {captionError ? <Text accessibilityRole="alert" style={styles.notice}>{captionError}</Text> : null}
        {picking ? (
          <Pressable accessibilityRole="button" style={styles.loadOlder} onPress={cancelPicker}>
            <Text style={styles.action}>Cancelar selección</Text>
          </Pressable>
        ) : null}
        {activeAttachment ? (
          <View style={styles.selectedFile}>
            <View style={styles.fileDetails}>
              <Text numberOfLines={2} style={styles.message}>{activeAttachment.filename}</Text>
              <Text style={styles.secondary}>{Math.ceil(activeAttachment.bytes.byteLength / 1024)} KB</Text>
            </View>
            {canEdit && !picking ? (
              <Pressable accessibilityRole="button" style={styles.removeFile} onPress={() => setSelectedAttachment(undefined)}>
                <Text style={styles.action}>Quitar archivo</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.composer}>
          <Pressable accessibilityRole="button" accessibilityLabel="Adjuntar archivo" accessibilityState={{ disabled: !canPick, busy: picking }}
            style={[styles.pick, !canPick && styles.disabled]} disabled={!canPick} onPress={() => void selectFile()}>
            {picking ? <ActivityIndicator color={colors.textPrimary} /> : <Paperclip size={18} color={colors.textPrimary} />}
          </Pressable>
          <TextInput
            style={styles.input}
            accessibilityLabel={activeAttachment ? 'Pie del archivo' : 'Escribir mensaje'}
            placeholder={hasActiveSession === false ? 'Ventana de atención cerrada' : activeAttachment ? 'Pie del archivo (opcional)' : 'Escribe un mensaje'}
            placeholderTextColor={colors.textMuted}
            multiline
            editable={canEdit}
            maxLength={activeAttachment ? MAX_ATTACHMENT_CAPTION_LENGTH : 4096}
            value={pending?.text ?? draft}
            onChangeText={setDraft}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={activeAttachment ? 'Enviar adjunto' : 'Enviar mensaje'}
            accessibilityState={{ disabled: !canSend, busy: sending }}
            style={[styles.send, !canSend && styles.disabled]}
            disabled={!canSend}
            onPress={sendDraft}
          >
            {sending ? <ActivityIndicator color={colors.textPrimary} /> : <Send size={18} color={colors.textPrimary} />}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10, backgroundColor: colors.surface, borderBottomWidth: 1, borderColor: colors.border },
  iconButton: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  headerContent: { flex: 1, gap: 3 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '700' },
  body: { flex: 1 },
  timeline: { padding: 16, gap: 8 },
  bubble: { maxWidth: '86%', alignSelf: 'flex-start', padding: 12, gap: 5, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  outbound: { alignSelf: 'flex-end', backgroundColor: '#134e4a', borderColor: '#0f766e' },
  message: { color: colors.textPrimary, fontSize: 15, lineHeight: 21 },
  attachment: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.surfaceLight },
  attachmentName: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  secondary: { color: colors.textSecondary, fontSize: 12 },
  notice: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, paddingHorizontal: 14, paddingVertical: 8 },
  empty: { minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: 8 },
  loadOlder: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  action: { color: colors.accent, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  selectedFile: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 4, backgroundColor: colors.surface },
  fileDetails: { flex: 1, gap: 2 },
  removeFile: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  pick: { width: 44, height: 46, backgroundColor: colors.surfaceLight, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  input: { flex: 1, color: colors.textPrimary, fontSize: 16, minHeight: 46, maxHeight: 120, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, borderRadius: 12 },
  send: { width: 46, height: 46, backgroundColor: colors.primaryHover, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  disabled: { opacity: 0.5 },
});
