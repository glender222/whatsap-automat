import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { uuid } from 'expo';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  apiClient, APPROVAL_PAGE_SIZE, MobileApiError,
  type MobileApproval, type MobileApprovalCommand, type MobileApprovalDecision,
} from '../services/apiClient';
import { canDecideMobileApproval, canReviewRiskOnMobile } from '../services/approvalPolicy';
import { useSession } from '../services/sessionContext';
import { useRefreshOnFocus } from '../services/useRefreshOnFocus';
import { DARK_THEME as colors, type RootStackParamList } from '../types/navigation';

const riskLabels = new Map([
  ['low', 'Bajo'], ['medium', 'Medio'], ['high', 'Alto'], ['read', 'Lectura'],
  ['write', 'Cambio interno'], ['send', 'Envío'], ['financial', 'Financiero'], ['destructive', 'Irreversible'],
]);
const statusLabels: Record<MobileApproval['status'], string> = {
  pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada', expired: 'Vencida', revoked: 'Revocada',
};

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('es-PE') : 'Fecha sin verificar';
}

function readError(error: unknown, fallback: string) {
  if (error instanceof MobileApiError && error.status === 403) return 'Tu espacio de trabajo no permite revisar aprobaciones.';
  if (error instanceof MobileApiError && error.status === 404) return 'Esta aprobación ya no está disponible.';
  return fallback;
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Volver" style={styles.back} onPress={onBack}>
        <ArrowLeft size={22} color={colors.textPrimary} />
      </Pressable>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    </View>
  );
}

function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      style={[styles.action, disabled && styles.disabled]} onPress={onPress}>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

export function ApprovalsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'Approvals'>) {
  const [items, setItems] = useState<MobileApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const offset = useRef(0);
  const reading = useRef(false);

  const load = useCallback(async (start = 0) => {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    setError('');
    try {
      const page = await apiClient.listApprovals(start);
      setItems((current) => {
        if (start === 0) return page;
        const shown = new Set(current.map(({ id }) => id));
        return [...current, ...page.filter(({ id }) => !shown.has(id))];
      });
      offset.current = start + page.length;
      setHasMore(page.length === APPROVAL_PAGE_SIZE);
    } catch (cause) {
      setError(readError(cause, 'No se pudo cargar la lista de aprobaciones.'));
      if (cause instanceof MobileApiError && cause.status === 403) {
        setItems([]);
        setHasMore(false);
      }
    } finally {
      reading.current = false;
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="Aprobaciones" onBack={navigation.goBack} />
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading && items.length > 0} onRefresh={() => void load()} />}
        ListHeaderComponent={error ? (
          <View style={styles.card}>
            <Text accessibilityRole="alert" style={styles.alert}>{error}</Text>
            <Action label="Volver a intentar" onPress={() => void load()} disabled={loading} />
          </View>
        ) : undefined}
        ListEmptyComponent={loading ? <ActivityIndicator accessibilityLabel="Cargando aprobaciones" color={colors.accent} /> :
          !error ? <Text style={styles.secondary}>No hay aprobaciones pendientes.</Text> : undefined}
        renderItem={({ item }) => {
          const title = item.details?.toolName || 'Solicitud de aprobación';
          const risk = riskLabels.get(item.risk) || 'Sin verificar';
          return (
            <Pressable accessibilityRole="button" accessibilityLabel={`Revisar ${title}, riesgo ${risk}`}
              style={styles.card} onPress={() => navigation.navigate('ApprovalDetail', { approvalId: item.id })}>
              <Text style={styles.heading}>{title}</Text>
              <Text style={styles.secondary}>Riesgo {risk} · Vence {dateLabel(item.expiresAt)}</Text>
            </Pressable>
          );
        }}
        ListFooterComponent={hasMore ? (
          <Action label="Cargar más aprobaciones" disabled={loading} onPress={() => void load(offset.current)} />
        ) : undefined}
      />
    </SafeAreaView>
  );
}

export function ApprovalDetailScreen({ route, navigation }: NativeStackScreenProps<RootStackParamList, 'ApprovalDetail'>) {
  const { approvalId } = route.params;
  const { approvalAttempts } = useSession();
  const [approval, setApproval] = useState<MobileApproval>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{ decision: MobileApprovalDecision; version: number }>();
  const [attempt, setAttempt] = useState(() => approvalAttempts.get(approvalId));
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const latest = await apiClient.getApproval(approvalId);
      setApproval((current) => {
        if (current && (latest.policyVersion < current.policyVersion ||
            (current.status !== 'pending' && latest.status === 'pending' && current.policyVersion === latest.policyVersion))) return current;
        return latest;
      });
      setLoadError('');
    } catch (cause) {
      setLoadError(readError(cause, 'No se pudo consultar esta aprobación.'));
      if (cause instanceof MobileApiError && [403, 404].includes(cause.status)) setApproval(undefined);
    } finally {
      setLoading(false);
    }
  }, [approvalId]);
  const refresh = useRefreshOnFocus(load);

  const clearAttempt = useCallback((command: MobileApprovalCommand) => {
    if (approvalAttempts.get(approvalId)?.key === command.key) approvalAttempts.delete(approvalId);
    setAttempt((current) => current?.key === command.key ? undefined : current);
  }, [approvalAttempts, approvalId]);

  useEffect(() => {
    if (attempt && approval && approval.status !== 'pending' && !submitting) {
      clearAttempt(attempt);
      setNotice(`Estado actualizado. La solicitud figura como ${statusLabels[approval.status].toLowerCase()}.`);
    }
  }, [approval, attempt, clearAttempt, submitting]);

  const canDecide = Boolean(approval && !loadError && canDecideMobileApproval(approval));

  async function submit(command: MobileApprovalCommand) {
    if (submittingRef.current || !approval || !canDecideMobileApproval(approval) || loadError ||
        command.expectedVersion !== approval.policyVersion) return;
    submittingRef.current = true;
    setSubmitting(true);
    approvalAttempts.set(approvalId, command);
    setAttempt(command);
    setConfirmation(undefined);
    setNotice('');
    try {
      const result = await apiClient.decideApproval(command);
      clearAttempt(command);
      setApproval((current) => current && {
        ...current, status: result.status, policyVersion: Math.max(current.policyVersion, command.expectedVersion + 1),
      });
      setNotice(result.status === 'approved' ? 'La aprobación se registró.' : 'El rechazo se registró.');
    } catch (cause) {
      if (cause instanceof MobileApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        clearAttempt(command);
        if (cause.status === 409) {
          setNotice('La solicitud cambió. Revisa el estado actualizado antes de volver a decidir.');
        } else if (cause.status === 410) {
          setApproval((current) => current && { ...current, status: 'expired' });
          setNotice('La solicitud venció y ya no admite decisiones.');
        } else {
          setNotice(readError(cause, 'El servidor rechazó la decisión.'));
        }
      } else {
        setNotice('El resultado sigue sin confirmar. Consulta el estado o reintenta la misma decisión.');
      }
    } finally {
      await refresh(true);
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function confirm() {
    if (!approval || !confirmation || submittingRef.current) return;
    if (!canDecideMobileApproval(approval) || loadError || approval.policyVersion !== confirmation.version) {
      setConfirmation(undefined);
      setNotice('La solicitud cambió o venció. Actualiza el detalle antes de decidir.');
      return;
    }
    const existing = approvalAttempts.get(approvalId);
    if (existing) {
      setAttempt(existing);
      setConfirmation(undefined);
      return;
    }
    void submit({ approvalId, decision: confirmation.decision, expectedVersion: confirmation.version, key: uuid.v4() });
  }

  const expired = approval?.status === 'pending' && Date.parse(approval.expiresAt) <= Date.now();

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="Detalle de aprobación" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? <ActivityIndicator accessibilityLabel="Cargando aprobación" color={colors.accent} /> : null}
        {loadError ? <Text accessibilityRole="alert" style={styles.alert}>{loadError}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.secondary}>{notice}</Text> : null}
        {approval ? (
          <>
            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.heading}>{approval.details?.toolName || 'Solicitud de aprobación'}</Text>
              <Text style={styles.secondary}>Riesgo {riskLabels.get(approval.risk) || 'sin verificar'}</Text>
              <Text style={styles.secondary}>{statusLabels[expired ? 'expired' : approval.status]} · Vence {dateLabel(approval.expiresAt)}</Text>
              {approval.details?.summary ? <Text style={styles.secondary}>{approval.details.summary}</Text> : null}
            </View>
            {approval.details?.parametersRedacted && Object.keys(approval.details.parametersRedacted).length ? (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>Datos de la acción</Text>
                <Text selectable style={styles.secondary}>{JSON.stringify(approval.details.parametersRedacted, null, 2)}</Text>
              </View>
            ) : null}
            {approval.status === 'pending' && !expired && !canReviewRiskOnMobile(approval.risk) ? (
              <Text accessibilityRole="alert" style={styles.alert}>
                {riskLabels.has(approval.risk)
                  ? 'Esta solicitud requiere verificación biométrica. La decisión está bloqueada en móvil.'
                  : 'No se pudo verificar el nivel de riesgo. La decisión está bloqueada en móvil.'}
              </Text>
            ) : null}
            {attempt && !submitting ? (
              <View style={styles.card}>
                <Text accessibilityRole="alert" style={styles.alert}>Hay una decisión sin confirmar en esta sesión.</Text>
                <Action label="Reintentar la misma decisión" disabled={!canDecide || approval.policyVersion !== attempt.expectedVersion}
                  onPress={() => void submit(attempt)} />
              </View>
            ) : null}
            {confirmation ? (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  {confirmation.decision === 'approved' ? '¿Confirmar aprobación?' : '¿Confirmar rechazo?'}
                </Text>
                <Text style={styles.secondary}>La decisión se registrará con tu cuenta.</Text>
                <View style={styles.actions}>
                  <Action label="Cancelar" onPress={() => setConfirmation(undefined)} />
                  <Action label={confirmation.decision === 'approved' ? 'Confirmar aprobación' : 'Confirmar rechazo'}
                    disabled={submitting || !canDecide} onPress={confirm} />
                </View>
              </View>
            ) : null}
            {canDecide && !confirmation && !attempt && !submitting ? (
              <View style={styles.actions}>
                <Action label="Aprobar" onPress={() => setConfirmation({ decision: 'approved', version: approval.policyVersion })} />
                <Action label="Rechazar" onPress={() => setConfirmation({ decision: 'rejected', version: approval.policyVersion })} />
              </View>
            ) : null}
          </>
        ) : null}
        {submitting ? <ActivityIndicator accessibilityLabel="Registrando decisión" color={colors.accent} /> : null}
        {!loading ? <Action label="Actualizar aprobación" disabled={submitting} onPress={() => void refresh()} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderBottomWidth: 1, borderColor: colors.border },
  back: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: colors.textPrimary, fontWeight: '800', fontSize: 20 },
  content: { gap: 12, padding: 16, paddingBottom: 28 },
  card: { gap: 8, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  heading: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  secondary: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  alert: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.surfaceLight },
  actionLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
