/**
 * Mobile Inbox Screen
 * Conversation list with unread badges, filter tabs (All, Mine, Unassigned),
 * search bar, pull-to-refresh, and live WebSocket streaming updates.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import {
  Search,
  MessageSquare,
  Bot,
  User,
} from 'lucide-react-native';
import { ConversationV1 } from '@whatsap-automat/contracts';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { apiClient } from '../services/apiClient';
import { socketService } from '../services/socketService';
import { authStorage } from '../services/authStorage';
import { RootStackParamList, DARK_THEME } from '../types/navigation';

type FilterTab = 'all' | 'mine' | 'unassigned';

type Props = NativeStackScreenProps<RootStackParamList, 'Inbox'>;

export const InboxScreen: React.FC<Props> = ({ navigation }) => {
  const [conversations, setConversations] = useState<ConversationV1[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string>('');

  // Load User & Conversations
  const loadConversations = useCallback(async () => {
    try {
      const uid = (await authStorage.getUserId()) || 'agent_mobile_1';
      setActiveUserId(uid);

      const res = await apiClient.listConversations({ limit: 50 });
      setConversations(res.items || []);
    } catch (err) {
      console.error('[InboxScreen] Failed to load conversations:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();

    // Connect WebSocket & Subscribe to Live Updates
    socketService.connect().then(() => {
      const unsubUpdate = socketService.onConversationUpdated((event) => {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id === event.conversationId) {
              return {
                ...conv,
                stateVersion: event.version,
                updatedAt: new Date().toISOString(),
              };
            }
            return conv;
          })
        );
      });

      return () => {
        unsubUpdate();
      };
    });
  }, [loadConversations]);

  const onRefresh = useCallback(() => {
    setIsRefreshing(true);
    loadConversations();
  }, [loadConversations]);

  // Filtered & Searched List
  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      // 1. Tab Filtering
      if (activeTab === 'mine' && c.assignedUserId !== activeUserId) {
        return false;
      }
      if (activeTab === 'unassigned' && c.assignedUserId !== null) {
        return false;
      }

      // 2. Search Query Filtering
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        const titleMatch = (c.title || '').toLowerCase().includes(q);
        const externalIdMatch = (c.externalConversationId || '').toLowerCase().includes(q);
        const channelMatch = (c.channel || '').toLowerCase().includes(q);
        return titleMatch || externalIdMatch || channelMatch;
      }

      return true;
    });
  }, [conversations, activeTab, activeUserId, searchQuery]);

  // Channel Badge Color
  const getChannelBadgeColor = (channel: string) => {
    switch (channel) {
      case 'whatsapp-cloud':
      case 'whatsapp':
        return '#25d366';
      case 'instagram':
        return '#e1306c';
      case 'telegram':
        return '#0088cc';
      case 'tiktok':
        return '#fe2c55';
      case 'line':
        return '#06c755';
      case 'email':
        return '#f59e0b';
      default:
        return DARK_THEME.primary;
    }
  };

  const renderConversationItem = ({ item }: { item: ConversationV1 }) => {
    const isAiHandling = !item.aiPaused && !item.assignedUserId;
    const channelColor = getChannelBadgeColor(item.channel);

    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() =>
          navigation.navigate('ChatDetail', {
            conversationId: item.id,
            conversationTitle: item.title || item.externalConversationId,
            channel: item.channel,
            initialConversation: item,
          })
        }
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleContainer}>
            <Text style={styles.contactTitle} numberOfLines={1}>
              {item.title || item.externalConversationId}
            </Text>
            <View
              style={[
                styles.channelPill,
                { backgroundColor: `${channelColor}20`, borderColor: channelColor },
              ]}
            >
              <Text style={[styles.channelPillText, { color: channelColor }]}>
                {item.channel}
              </Text>
            </View>
          </View>
          <Text style={styles.timeText}>
            {item.lastMessageAt
              ? new Date(item.lastMessageAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'New'}
          </Text>
        </View>

        <Text style={styles.externalIdText} numberOfLines={1}>
          {item.externalConversationId} • Stage: {item.stage}
        </Text>

        <View style={styles.cardFooter}>
          <View style={styles.statusPills}>
            {isAiHandling ? (
              <View style={[styles.badge, styles.badgeAi]}>
                <Bot size={12} color="#ffffff" />
                <Text style={styles.badgeText}>AI Handling</Text>
              </View>
            ) : (
              <View style={[styles.badge, styles.badgeHuman]}>
                <User size={12} color="#ffffff" />
                <Text style={styles.badgeText}>
                  {item.assignedUserId === activeUserId
                    ? 'Assigned to You'
                    : `Agent ${item.assignedUserId || 'Manual'}`}
                </Text>
              </View>
            )}
            <View style={styles.versionPill}>
              <Text style={styles.versionText}>CAS v{item.stateVersion}</Text>
            </View>
          </View>

          {item.status === 'open' && (
            <View style={styles.unreadIndicator}>
              <Text style={styles.unreadText}>Open</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={DARK_THEME.background} />

      {/* Screen Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Operational Inbox</Text>
        <View style={styles.searchBox}>
          <Search size={18} color={DARK_THEME.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search conversations, phones..."
            placeholderTextColor={DARK_THEME.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      {/* Filter Tabs */}
      <View style={styles.tabContainer}>
        {(['all', 'mine', 'unassigned'] as FilterTab[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.tabButton, activeTab === tab && styles.tabButtonActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Conversations List */}
      <FlatList
        data={filteredConversations}
        keyExtractor={(item) => item.id}
        renderItem={renderConversationItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={DARK_THEME.primary}
            colors={[DARK_THEME.primary]}
          />
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.emptyContainer}>
              <MessageSquare size={48} color={DARK_THEME.border} />
              <Text style={styles.emptyTitle}>No conversations found</Text>
              <Text style={styles.emptySubtitle}>
                Try adjusting your search query or switching filters.
              </Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: DARK_THEME.background,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: DARK_THEME.textPrimary,
    marginBottom: 10,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DARK_THEME.surface,
    borderWidth: 1,
    borderColor: DARK_THEME.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    color: DARK_THEME.textPrimary,
    fontSize: 14,
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: DARK_THEME.border,
  },
  tabButton: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: DARK_THEME.surface,
  },
  tabButtonActive: {
    backgroundColor: DARK_THEME.primary,
  },
  tabText: {
    fontSize: 13,
    color: DARK_THEME.textSecondary,
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: DARK_THEME.surface,
    borderWidth: 1,
    borderColor: DARK_THEME.border,
    borderRadius: 12,
    padding: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  cardTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  contactTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: DARK_THEME.textPrimary,
    maxWidth: '65%',
  },
  channelPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  channelPillText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  timeText: {
    fontSize: 11,
    color: DARK_THEME.textMuted,
  },
  externalIdText: {
    fontSize: 12,
    color: DARK_THEME.textMuted,
    marginBottom: 10,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusPills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeAi: {
    backgroundColor: DARK_THEME.badgeAi,
  },
  badgeHuman: {
    backgroundColor: DARK_THEME.badgeHuman,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ffffff',
  },
  versionPill: {
    backgroundColor: DARK_THEME.surfaceLight,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  versionText: {
    fontSize: 10,
    color: DARK_THEME.textSecondary,
    fontFamily: 'monospace',
  },
  unreadIndicator: {
    backgroundColor: 'rgba(13, 148, 136, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  unreadText: {
    fontSize: 11,
    color: DARK_THEME.accent,
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: DARK_THEME.textSecondary,
  },
  emptySubtitle: {
    fontSize: 13,
    color: DARK_THEME.textMuted,
    textAlign: 'center',
    maxWidth: 250,
  },
});
