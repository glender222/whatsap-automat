import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LogOut, MessageSquare, Search } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { apiClient, type MobileConversation } from '../services/apiClient';
import { useSession } from '../services/sessionContext';
import { useRefreshOnFocus } from '../services/useRefreshOnFocus';
import { DARK_THEME as colors, type RootStackParamList } from '../types/navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Inbox'>;

const filters = [
  { id: 'all', label: 'Todos' },
  { id: 'mine', label: 'Asignados a mí' },
  { id: 'unassigned', label: 'Sin asignar' },
] as const;

type Filter = (typeof filters)[number]['id'];

function timeLabel(timestamp?: number) {
  if (!timestamp) return '';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function InboxScreen({ navigation }: Props) {
  const { session, signOut } = useSession();
  const [conversations, setConversations] = useState<MobileConversation[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [error, setError] = useState('');
  const offset = useRef(0);

  const load = useCallback(async () => {
    try {
      const page = await apiClient.listConversations();
      if (offset.current <= 50) {
        offset.current = page.length;
        setCanLoadMore(page.length === 50);
      }
      setConversations((current) => {
        if (offset.current <= 50) return page;
        const latestIds = new Set(page.map((item) => item.id));
        return [...page, ...current.filter((item) => !latestIds.has(item.id))];
      });
      setError('');
    } catch {
      setError('No pudimos cargar las conversaciones. Revisa tu conexión y vuelve a intentar.');
    } finally {
      setLoading(false);
    }
  }, []);
  const refresh = useRefreshOnFocus(load);

  async function refreshList() {
    setRefreshing(true);
    offset.current = 0;
    await refresh();
    setRefreshing(false);
  }

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiClient.listConversations(offset.current);
      offset.current += page.length;
      setCanLoadMore(page.length === 50);
      setConversations((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...page.filter((item) => !ids.has(item.id))];
      });
      setError('');
    } catch {
      setError('No se pudo cargar la siguiente página. Puedes volver a intentarlo.');
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return conversations.filter((item) => {
      const assigned = item.assignedUserId == null ? null : String(item.assignedUserId);
      if (filter === 'mine' && assigned !== session.userId) return false;
      if (filter === 'unassigned' && assigned !== null) return false;
      return [item.name, item.id, item.lastMessagePreview].some((text) => text?.toLocaleLowerCase().includes(query));
    });
  }, [conversations, filter, search, session.userId]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.titleGroup}>
            <Text style={styles.eyebrow}>WHATSAP AUTOMAT</Text>
            <Text style={styles.title} accessibilityRole="header">Bandeja de entrada</Text>
          </View>
          <Pressable style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Cerrar sesión" onPress={signOut}>
            <LogOut size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.search}>
          <Search color={colors.textMuted} size={18} />
          <TextInput
            style={styles.searchInput}
            accessibilityLabel="Buscar conversaciones"
            placeholder="Buscar por nombre o número"
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      </View>

      <View style={styles.filters} accessibilityRole="tablist">
        {filters.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === item.id }}
            onPress={() => setFilter(item.id)}
            style={[styles.filter, filter === item.id && styles.selectedFilter]}
          >
            <Text style={[styles.filterLabel, filter === item.id && styles.selectedLabel]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.noticeText}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void refreshList()} style={styles.textButton}>
            <Text style={styles.action}>Actualizar bandeja</Text>
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.secondary}>Cargando conversaciones…</Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshList} tintColor={colors.accent} colors={[colors.accent]} />}
          renderItem={({ item }) => {
            const title = item.name?.trim() || item.id;
            const unread = item.unreadCount ?? 0;
            return (
              <Pressable
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={unread > 0 ? `${title}, ${unread} sin leer` : title}
                onPress={() => navigation.navigate('ChatDetail', { chat: item })}
              >
                <View style={styles.avatar}><Text style={styles.avatarText}>{title.slice(0, 2).toUpperCase()}</Text></View>
                <View style={styles.rowContent}>
                  <Text style={styles.contact} numberOfLines={1}>{title}</Text>
                  <Text style={styles.secondary} numberOfLines={1}>{item.lastMessagePreview || 'Sin vista previa'}</Text>
                </View>
                <View style={styles.rowMeta}>
                  <Text style={styles.timestamp}>{timeLabel(item.lastMessageTimestamp)}</Text>
                  {unread > 0 ? <Text style={styles.unread}>{unread > 99 ? '99+' : unread}</Text> : null}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={!error ? (
            <View style={styles.empty}>
              <MessageSquare size={32} color={colors.textMuted} />
              <Text style={styles.contact}>No hay conversaciones</Text>
              <Text style={styles.secondary}>
                {search || filter !== 'all' ? 'Prueba otro filtro o término de búsqueda.' : 'Los mensajes nuevos aparecerán aquí.'}
              </Text>
            </View>
          ) : null}
          ListFooterComponent={canLoadMore ? (
            <Pressable style={styles.more} accessibilityRole="button" disabled={loadingMore} onPress={() => void loadMore()}>
              <Text style={styles.action}>{loadingMore ? 'Cargando…' : 'Cargar más conversaciones'}</Text>
            </Pressable>
          ) : null}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 16, paddingTop: 12, gap: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleGroup: { flex: 1, gap: 4 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.7 },
  title: { color: colors.textPrimary, fontSize: 25, fontWeight: '800' },
  iconButton: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 46, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10 },
  searchInput: { flex: 1, minHeight: 44, color: colors.textPrimary, fontSize: 16 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 12, paddingHorizontal: 16, gap: 8 },
  filter: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surface },
  selectedFilter: { backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.primary },
  filterLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },
  selectedLabel: { color: colors.textPrimary },
  list: { paddingHorizontal: 16, paddingBottom: 20, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, minHeight: 66, borderRadius: 12, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  avatar: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  avatarText: { color: colors.accent, fontWeight: '800', fontSize: 13 },
  rowContent: { flex: 1, gap: 4 },
  contact: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  rowMeta: { alignItems: 'flex-end', gap: 6 },
  secondary: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  timestamp: { color: colors.textMuted, fontSize: 12 },
  unread: { color: colors.textPrimary, fontSize: 12, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, backgroundColor: colors.primaryHover },
  notice: { paddingHorizontal: 16, paddingVertical: 8 },
  noticeText: { color: '#fda4af', lineHeight: 20 },
  textButton: { minHeight: 44, justifyContent: 'center' },
  action: { color: colors.accent, fontWeight: '700' },
  empty: { minHeight: 160, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 8 },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
