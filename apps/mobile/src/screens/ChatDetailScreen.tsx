/**
 * Mobile Chat Detail Screen
 * Message timeline (inbound/outbound bubbles), delivery receipts,
 * composer with Idempotency-Key & CAS protection, and embedded TakeoverButton.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import {
  Send,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Bot,
  User,
} from 'lucide-react-native';
import { ConversationV1, ConversationMessageV1 } from '@whatsap-automat/contracts';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { apiClient } from '../services/apiClient';
import { socketService } from '../services/socketService';
import { authStorage } from '../services/authStorage';
import { TakeoverButton } from '../components/TakeoverButton';
import { RootStackParamList, DARK_THEME } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'ChatDetail'>;

export const ChatDetailScreen: React.FC<Props> = ({ route, navigation }) => {
  const { conversationId, initialConversation } = route.params;

  const [conversation, setConversation] = useState<ConversationV1 | null>(
    initialConversation || null
  );
  const [messages, setMessages] = useState<ConversationMessageV1[]>([]);
  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string>('');
  const [isTypingPeer, setIsTypingPeer] = useState(false);

  const flatListRef = useRef<FlatList>(null);

  // Load Initial Conversation & Message Timeline
  const loadData = useCallback(async () => {
    try {
      const uid = (await authStorage.getUserId()) || 'agent_mobile_1';
      setActiveUserId(uid);

      const [conv, msgs] = await Promise.all([
        apiClient.getConversation(conversationId),
        apiClient.listMessages(conversationId, { limit: 50 }),
      ]);

      setConversation(conv);
      setMessages(msgs.items || []);
    } catch (err) {
      console.error('[ChatDetailScreen] Failed to load chat data:', err);
    }
  }, [conversationId]);

  useEffect(() => {
    loadData();

    // Join Conversation Socket Room
    socketService.joinConversation(conversationId);

    // Live Socket Listeners
    const unsubMessage = socketService.onMessageCreated((newMsg) => {
      if (newMsg.conversationId === conversationId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) return prev;
          return [...prev, newMsg];
        });
      }
    });

    const unsubUpdated = socketService.onConversationUpdated((event) => {
      if (event.conversationId === conversationId) {
        setConversation((prev) =>
          prev ? { ...prev, stateVersion: event.version } : prev
        );
      }
    });

    const unsubTyping = socketService.onTyping((event) => {
      if (event.conversationId === conversationId && event.userId !== activeUserId) {
        setIsTypingPeer(event.isTyping);
      }
    });

    return () => {
      unsubMessage();
      unsubUpdated();
      unsubTyping();
      socketService.leaveConversation(conversationId);
    };
  }, [conversationId, loadData, activeUserId]);

  // Send Message with CAS Version Protection & Idempotency Key
  const handleSendMessage = async () => {
    const text = composerText.trim();
    if (!text || isSending || !conversation) return;

    setIsSending(true);
    const clientReqId = `mobile_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // Optimistic Message insertion
    const optimisticMsg: ConversationMessageV1 = {
      id: clientReqId,
      conversationId: conversation.id,
      tenantId: conversation.tenantId,
      connectionId: conversation.connectionId,
      channel: conversation.channel,
      direction: 'outbound',
      deliveryState: 'pending',
      originEventId: null,
      clientRequestId: clientReqId,
      correlationId: null,
      body: text,
      attachments: [],
      causedBy: {
        type: 'human',
        id: activeUserId,
      },
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMsg]);
    setComposerText('');

    try {
      const result = await apiClient.sendMessage(conversation.id, {
        text,
        expectedConversationVersion: conversation.stateVersion,
        idempotencyKey: clientReqId,
      });

      // Update message delivery state to dispatched
      setMessages((prev) =>
        prev.map((m) =>
          m.id === clientReqId
            ? { ...m, deliveryState: (result.deliveryState as any) || 'dispatched' }
            : m
        )
      );
    } catch (err: any) {
      if (err?.status === 409) {
        Alert.alert(
          'CAS Conflict on Send',
          'The conversation version has advanced. Your message could not be delivered concurrently. Reloading latest messages...',
          [{ text: 'Reload', onPress: loadData }]
        );
      }

      // Mark message as failed
      setMessages((prev) =>
        prev.map((m) =>
          m.id === clientReqId ? { ...m, deliveryState: 'failed' } : m
        )
      );
    } finally {
      setIsSending(false);
    }
  };

  const renderDeliveryIcon = (state: string) => {
    switch (state) {
      case 'pending':
        return <Clock size={12} color={DARK_THEME.textMuted} />;
      case 'dispatched':
        return <Check size={13} color={DARK_THEME.textMuted} />;
      case 'delivered':
      case 'provider_accepted':
        return <CheckCheck size={14} color={DARK_THEME.textSecondary} />;
      case 'read':
        return <CheckCheck size={14} color="#38bdf8" />; // sky-400
      case 'failed':
        return <AlertCircle size={13} color={DARK_THEME.danger} />;
      default:
        return null;
    }
  };

  const renderMessageBubble = ({ item }: { item: ConversationMessageV1 }) => {
    const isOutbound = item.direction === 'outbound';
    const isAi = item.causedBy?.type === 'agent';

    return (
      <View
        style={[
          styles.messageRow,
          isOutbound ? styles.messageRowOutbound : styles.messageRowInbound,
        ]}
      >
        <View
          style={[
            styles.bubble,
            isOutbound ? (isAi ? styles.bubbleAi : styles.bubbleHuman) : styles.bubbleInbound,
          ]}
        >
          {/* Sender label */}
          <View style={styles.bubbleHeader}>
            {isOutbound ? (
              isAi ? (
                <View style={styles.senderPill}>
                  <Bot size={11} color="#c7d2fe" />
                  <Text style={styles.senderText}>AI Copilot</Text>
                </View>
              ) : (
                <View style={styles.senderPill}>
                  <User size={11} color="#a7f3d0" />
                  <Text style={styles.senderText}>You</Text>
                </View>
              )
            ) : (
              <Text style={styles.inboundSenderText}>
                {conversation?.title || 'Customer'}
              </Text>
            )}
          </View>

          <Text style={styles.messageText}>{item.body}</Text>

          <View style={styles.bubbleFooter}>
            <Text style={styles.bubbleTime}>
              {new Date(item.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
            {isOutbound && renderDeliveryIcon(item.deliveryState)}
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Top Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          accessibilityLabel="Back to Inbox"
        >
          <ArrowLeft size={22} color={DARK_THEME.textPrimary} />
        </TouchableOpacity>

        <View style={styles.headerInfo}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {conversation?.title || route.params.conversationTitle || 'Chat'}
          </Text>
          <Text style={styles.headerSubtitle}>
            {conversation?.channel} • v{conversation?.stateVersion ?? 1}
          </Text>
        </View>

        {conversation && (
          <TakeoverButton
            conversationId={conversation.id}
            expectedVersion={conversation.stateVersion}
            activeUserId={activeUserId}
            assignedUserId={conversation.assignedUserId}
            aiPaused={conversation.aiPaused}
            onTakeoverSuccess={(res) => {
              setConversation((prev) =>
                prev
                  ? {
                      ...prev,
                      stateVersion: res.newVersion ?? prev.stateVersion + 1,
                      assignedUserId: activeUserId,
                      aiPaused: true,
                    }
                  : prev
              );
            }}
            onReloadRequested={loadData}
          />
        )}
      </View>

      {/* Message Timeline */}
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessageBubble}
          contentContainerStyle={styles.timelineContent}
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: true })
          }
        />

        {/* Peer Typing Indicator */}
        {isTypingPeer && (
          <View style={styles.typingIndicator}>
            <Text style={styles.typingText}>Customer is typing...</Text>
          </View>
        )}

        {/* Composer Bar */}
        <View style={styles.composerBar}>
          <TextInput
            style={styles.composerInput}
            placeholder="Type message as human operator..."
            placeholderTextColor={DARK_THEME.textMuted}
            value={composerText}
            onChangeText={(text) => {
              setComposerText(text);
              socketService.emitTyping(conversationId, text.length > 0);
            }}
            multiline
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!composerText.trim() || isSending) && styles.sendButtonDisabled,
            ]}
            onPress={handleSendMessage}
            disabled={!composerText.trim() || isSending}
            accessibilityLabel="Send message"
          >
            {isSending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Send size={18} color="#ffffff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: DARK_THEME.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: DARK_THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: DARK_THEME.border,
    gap: 12,
  },
  backButton: {
    padding: 4,
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: DARK_THEME.textPrimary,
  },
  headerSubtitle: {
    fontSize: 11,
    color: DARK_THEME.textMuted,
    textTransform: 'uppercase',
  },
  keyboardContainer: {
    flex: 1,
  },
  timelineContent: {
    padding: 16,
    gap: 12,
  },
  messageRow: {
    flexDirection: 'row',
    width: '100%',
  },
  messageRowInbound: {
    justifyContent: 'flex-start',
  },
  messageRowOutbound: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '82%',
    padding: 12,
    borderRadius: 14,
  },
  bubbleInbound: {
    backgroundColor: DARK_THEME.surface,
    borderBottomLeftRadius: 2,
    borderWidth: 1,
    borderColor: DARK_THEME.border,
  },
  bubbleHuman: {
    backgroundColor: DARK_THEME.primary, // teal-600
    borderBottomRightRadius: 2,
  },
  bubbleAi: {
    backgroundColor: DARK_THEME.badgeAi, // indigo-500
    borderBottomRightRadius: 2,
  },
  bubbleHeader: {
    marginBottom: 4,
  },
  senderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  senderText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
    textTransform: 'uppercase',
  },
  inboundSenderText: {
    fontSize: 11,
    fontWeight: '600',
    color: DARK_THEME.accent,
  },
  messageText: {
    fontSize: 14,
    color: '#ffffff',
    lineHeight: 20,
  },
  bubbleFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  bubbleTime: {
    fontSize: 10,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  typingIndicator: {
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  typingText: {
    fontSize: 12,
    color: DARK_THEME.accent,
    fontStyle: 'italic',
  },
  composerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: DARK_THEME.surface,
    borderTopWidth: 1,
    borderTopColor: DARK_THEME.border,
    gap: 10,
  },
  composerInput: {
    flex: 1,
    backgroundColor: DARK_THEME.background,
    color: DARK_THEME.textPrimary,
    borderWidth: 1,
    borderColor: DARK_THEME.border,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    maxHeight: 100,
    fontSize: 14,
  },
  sendButton: {
    backgroundColor: DARK_THEME.primary,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
});
