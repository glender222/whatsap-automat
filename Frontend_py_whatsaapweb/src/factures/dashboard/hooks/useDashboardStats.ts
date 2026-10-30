import { useCallback, useEffect, useRef, useState } from 'react';
import SocketService from '../../../utils/socket';
import {
  type ActionCardsStats,
  type HeatmapByDateMatrix,
  type QuickStats,
  type SlaAlertsResult,
  type WhatsappStatusSummary,
  dashboardService,
} from '../services/dashboardService';

type LoadState = 'loading' | 'ready' | 'error';

type DashboardState = {
  quickStats: QuickStats | null;
  actionCards: ActionCardsStats;
  heatmap: HeatmapByDateMatrix | null;
  slaAlerts: SlaAlertsResult | null;
  whatsappStatus: WhatsappStatusSummary | null;
  quickStatsState: LoadState;
  actionCardsState: LoadState;
  heatmapState: LoadState;
  slaAlertsState: LoadState;
  whatsappState: LoadState;
  lastUpdated: Date | null;
  reloadAll: () => Promise<void>;
  reloadQuickStats: () => Promise<void>;
  reloadActionCards: () => Promise<void>;
  reloadHeatmap: () => Promise<void>;
  reloadSlaAlerts: () => Promise<void>;
};

const emptyActionCards: ActionCardsStats = {
  pendingChatsCount: 0,
  pendingPaymentsCount: 0,
  lowStockCount: 0,
};

export function useDashboardStats(heatmapDays = 7, slaLimit = 20): DashboardState {
  const [quickStats, setQuickStats] = useState<QuickStats | null>(null);
  const [actionCards, setActionCards] = useState<ActionCardsStats | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapByDateMatrix | null>(null);
  const [slaAlerts, setSlaAlerts] = useState<SlaAlertsResult | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsappStatusSummary | null>(null);
  const [quickStatsState, setQuickStatsState] = useState<LoadState>('loading');
  const [actionCardsState, setActionCardsState] = useState<LoadState>('loading');
  const [heatmapState, setHeatmapState] = useState<LoadState>('loading');
  const [slaAlertsState, setSlaAlertsState] = useState<LoadState>('loading');
  const [whatsappState, setWhatsappState] = useState<LoadState>('loading');

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const reloadQuickStats = useCallback(async () => {
    setQuickStatsState('loading');
    try {
      const data = await dashboardService.getQuickStats();
      if (!mountedRef.current) return;
      setQuickStats(data);
      setQuickStatsState('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      console.error('Error cargando quick stats:', error);
      setQuickStatsState('error');
    }
  }, []);

  const reloadActionCards = useCallback(async () => {
    setActionCardsState('loading');
    try {
      const data = await dashboardService.getActionCards();
      if (!mountedRef.current) return;
      setActionCards(data);
      setActionCardsState('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      console.error('Error cargando action cards:', error);
      setActionCardsState('error');
    }
  }, []);

  const reloadHeatmap = useCallback(async () => {
    setHeatmapState('loading');
    try {
      const data = await dashboardService.getHeatmap(heatmapDays);
      if (!mountedRef.current) return;
      setHeatmap(data);
      setHeatmapState('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      console.error('Error cargando heatmap:', error);
      setHeatmapState('error');
    }
  }, [heatmapDays]);

  const reloadSlaAlerts = useCallback(async () => {
    setSlaAlertsState('loading');
    try {
      const data = await dashboardService.getSlaAlerts(slaLimit);
      if (!mountedRef.current) return;
      setSlaAlerts(data);
      setSlaAlertsState('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      console.error('Error cargando SLA alerts:', error);
      setSlaAlertsState('error');
    }
  }, [slaLimit]);

  const reloadWhatsapp = useCallback(async () => {
    setWhatsappState('loading');
    try {
      const data = await dashboardService.getWhatsappStatus();
      if (!mountedRef.current) return;
      setWhatsappStatus(data);
      setWhatsappState('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      console.error('Error cargando whatsapp status:', error);
      setWhatsappState('error');
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await Promise.allSettled([
      reloadQuickStats(),
      reloadActionCards(),
      reloadHeatmap(),
      reloadSlaAlerts(),
      reloadWhatsapp(),
    ]);
    if (mountedRef.current) setLastUpdated(new Date());
  }, [reloadQuickStats, reloadActionCards, reloadHeatmap, reloadSlaAlerts, reloadWhatsapp]);

  useEffect(() => {
    mountedRef.current = true;
    reloadAll();
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [reloadAll]);

  useEffect(() => {
    const socket = SocketService.getInstance().connect();

    const scheduleRefresh = (targets: Array<() => Promise<void>>): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        targets.forEach((fn) => fn());
        setLastUpdated(new Date());
      }, 3000);
    };

    const onChatsUpdated = () => scheduleRefresh([reloadQuickStats, reloadSlaAlerts]);
    const onMessage = () => scheduleRefresh([reloadQuickStats, reloadSlaAlerts]);
    const onPaymentCreated = () => scheduleRefresh([reloadActionCards, reloadSlaAlerts]);
    const onPaymentUpdated = () => scheduleRefresh([reloadActionCards, reloadSlaAlerts]);
    const onOrderStatusChanged = () => scheduleRefresh([reloadQuickStats, reloadActionCards]);
    const onStockUpdated = () => scheduleRefresh([reloadActionCards]);

    socket.on('chats-updated', onChatsUpdated);
    socket.on('message', onMessage);
    socket.on('payment-created', onPaymentCreated);
    socket.on('payment-updated', onPaymentUpdated);
    socket.on('order-status-changed', onOrderStatusChanged);
    socket.on('stock-updated', onStockUpdated);

    return () => {
      socket.off('chats-updated', onChatsUpdated);
      socket.off('message', onMessage);
      socket.off('payment-created', onPaymentCreated);
      socket.off('payment-updated', onPaymentUpdated);
      socket.off('order-status-changed', onOrderStatusChanged);
      socket.off('stock-updated', onStockUpdated);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [reloadQuickStats, reloadSlaAlerts, reloadActionCards]);

  return {
    quickStats,
    actionCards: actionCards ?? emptyActionCards,
    heatmap,
    slaAlerts,
    whatsappStatus,
    quickStatsState,
    actionCardsState,
    heatmapState,
    slaAlertsState,
    whatsappState,
    lastUpdated,
    reloadAll,
    reloadQuickStats,
    reloadActionCards,
    reloadHeatmap,
    reloadSlaAlerts,
  };
};
