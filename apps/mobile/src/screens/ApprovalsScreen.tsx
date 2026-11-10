import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { uuid } from 'expo';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  apiClient, APPROVAL_PAGE_SIZE, MobileApiError,
  type MobileApproval, type MobileApprovalCommand, type MobileApprovalDecision,
} from '../services/apiClient';
import {
  APPROVAL_REAUTH_CAPABILITY, MAX_APPROVAL_REASON_LENGTH, canDecideMobileApproval, canReviewRiskOnMobile,
  requiresApprovalReauthentication,
} from '../services/approvalPolicy';
import { useApprovalFeed } from '../services/approvalFeed';
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

function reauthenticationError(error: MobileApiError) {
  if (error.accessTokenExpired) return 'El acceso venció. Vuelve a escribir tu contraseña para confirmar.';
  switch (error.metadata?.reason) {
    case 'APPROVAL_REAUTH_REQUIRED': return 'Ingresa tu contraseña actual para confirmar la decisión.';
    case 'APPROVAL_REAUTH_INVALID': return 'La contraseña no es correcta. Vuelve a ingresarla.';
    case 'APPROVAL_REAUTH_LIMITED': return error.retryAfterSeconds
      ? `Se alcanzó el límite de intentos. Vuelve a intentar en ${error.retryAfterSeconds} segundos.`
      : 'Se alcanzó el límite de intentos. Vuelve a intentar más tarde.';
    default: return undefined;
  }
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
  const { isSessionActive } = useSession();
  const { page, loading, error, refresh, dismiss } = useApprovalFeed();
  const [nextPage, setNextPage] = useState<{ anchor: string; items: MobileApproval[]; offset: number; hasMore: boolean }>();
  const [moreError, setMoreError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reading = useRef(false);
  const pagination = useRef(0);
  const anchor = JSON.stringify(page.map(({ id }) => id));
  const older = nextPage?.anchor === anchor ? nextPage : undefined;
  const items = older ? [...page, ...older.items] : page;
  const hasMore = older?.hasMore ?? page.length === APPROVAL_PAGE_SIZE;

  useEffect(() => {
    pagination.current++;
    setNextPage(undefined);
    setMoreError('');
  }, [anchor]);

  async function loadMore() {
    if (reading.current || refreshing || !isSessionActive()) return;
    reading.current = true;
    setLoadingMore(true);
    setMoreError('');
    const started = pagination.current;
    const offset = older?.offset ?? page.length;
    try {
      const next = await apiClient.listApprovals(offset);
      if (!isSessionActive() || started !== pagination.current) return;
      const shown = new Set(items.map(({ id }) => id));
      setNextPage({
        anchor, offset: offset + next.length, hasMore: next.length === APPROVAL_PAGE_SIZE,
        items: [...(older?.items ?? []), ...next.filter(({ id }) => !shown.has(id))],
      });
    } catch (cause) {
      if (!isSessionActive() || started !== pagination.current) return;
      setMoreError(readError(cause, 'No se pudo cargar la siguiente página.'));
      if (cause instanceof MobileApiError && cause.status === 403) {
        setNextPage(undefined);
        void refresh(true);
      }
    } finally {
      reading.current = false;
      setLoadingMore(false);
    }
  }

  async function refreshList() {
    setRefreshing(true);
    pagination.current++;
    setNextPage(undefined);
    setMoreError('');
    await refresh(true);
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="Aprobaciones" onBack={navigation.goBack} />
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshList()} />}
        ListHeaderComponent={error || moreError ? (
          <View style={styles.card}>
            <Text accessibilityRole="alert" style={styles.alert}>{error || moreError}</Text>
            <Action label="Volver a intentar" onPress={() => void refreshList()} disabled={refreshing} />
          </View>
        ) : undefined}
        ListEmptyComponent={loading ? <ActivityIndicator accessibilityLabel="Cargando aprobaciones" color={colors.accent} /> :
          !error ? <Text style={styles.secondary}>No hay aprobaciones pendientes.</Text> : undefined}
        renderItem={({ item }) => {
          const title = item.details?.toolName || 'Solicitud de aprobación';
          const risk = riskLabels.get(item.risk) || 'Sin verificar';
          return (
            <Pressable accessibilityRole="button" accessibilityLabel={`Revisar ${title}, riesgo ${risk}`}
              style={styles.card} onPress={() => {
                dismiss(item.id);
                navigation.navigate('ApprovalDetail', { approvalId: item.id });
              }}>
              <Text style={styles.heading}>{title}</Text>
              <Text style={styles.secondary}>Riesgo {risk} · Vence {dateLabel(item.expiresAt)}</Text>
            </Pressable>
          );
        }}
        ListFooterComponent={hasMore ? (
          <Action label="Cargar más aprobaciones" disabled={loadingMore || refreshing} onPress={() => void loadMore()} />
        ) : undefined}
      />
    </SafeAreaView>
  );
}

export function ApprovalDetailScreen({ route, navigation }: NativeStackScreenProps<RootStackParamList, 'ApprovalDetail'>) {
  const { approvalId } = route.params;
  const { approvalAttempts, isSessionActive, session } = useSession();
  const { canReauthenticate, refresh: refreshApprovalList } = useApprovalFeed();
  const [approval, setApproval] = useState<MobileApproval>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<MobileApprovalCommand>();
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(false);
  const [retryAllowedAt, setRetryAllowedAt] = useState(0);
  const [attempt, setAttempt] = useState(() => approvalAttempts.get(approvalId));
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const checkingRef = useRef(false);
  const formGeneration = useRef(0);
  const lastRead = useRef<MobileApproval | undefined>(undefined);
  const reauthenticationSupported = canReauthenticate && session.apiUrl.startsWith('https://');
  const sensitive = Boolean(approval && requiresApprovalReauthentication(approval.risk));

  const load = useCallback(async () => {
    try {
      const latest = await apiClient.getApproval(approvalId);
      if (!isSessionActive()) return;
      lastRead.current = latest;
      setApproval((current) => {
        if (current && (latest.policyVersion < current.policyVersion ||
            (current.status !== 'pending' && latest.status === 'pending' && current.policyVersion === latest.policyVersion))) return current;
        return latest;
      });
      setLoadError('');
    } catch (cause) {
      if (!isSessionActive()) return;
      lastRead.current = undefined;
      setLoadError(readError(cause, 'No se pudo consultar esta aprobación.'));
      if (cause instanceof MobileApiError && [403, 404].includes(cause.status)) setApproval(undefined);
    } finally {
      setLoading(false);
    }
  }, [approvalId, isSessionActive]);
  const refresh = useRefreshOnFocus(load);

  useFocusEffect(useCallback(() => {
    const clearPassword = () => {
      formGeneration.current++;
      setPassword('');
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') clearPassword();
    });
    return () => {
      subscription.remove();
      clearPassword();
    };
  }, []));

  useEffect(() => {
    if (!retryAllowedAt) return;
    const timer = setTimeout(() => setRetryAllowedAt(0), Math.max(0, retryAllowedAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAllowedAt]);

  const clearAttempt = useCallback((command: MobileApprovalCommand) => {
    if (approvalAttempts.get(approvalId)?.key === command.key) approvalAttempts.delete(approvalId);
    setAttempt((current) => current?.key === command.key ? undefined : current);
  }, [approvalAttempts, approvalId]);

  useEffect(() => {
    if (!attempt || !approval || submitting) return;
    if (approval.status !== 'pending') {
      clearAttempt(attempt);
      setNotice(`Estado actualizado. La solicitud figura como ${statusLabels[approval.status].toLowerCase()}.`);
    } else if (approval.policyVersion > attempt.expectedVersion) {
      clearAttempt(attempt);
      setNotice('La solicitud cambió. Revisa los datos actualizados y confirma una nueva decisión.');
    }
  }, [approval, attempt, clearAttempt, submitting]);

  const canDecide = Boolean(approval && !loadError && canDecideMobileApproval(approval, Date.now(), reauthenticationSupported));
  const reauthLimited = sensitive && retryAllowedAt > Date.now();

  useEffect(() => {
    if (!confirmation || (canDecide && approval?.policyVersion === confirmation.expectedVersion)) return;
    setConfirmation(undefined);
    setPassword('');
    setReason('');
  }, [approval?.policyVersion, canDecide, confirmation]);

  function review(command: MobileApprovalCommand) {
    setPassword('');
    setReason(command.reason ?? '');
    setConfirmation(command);
  }

  async function submit(command: MobileApprovalCommand, credential?: string) {
    if (submittingRef.current || !isSessionActive() || !canDecide || !approval || reauthLimited ||
        (sensitive && (!credential || !command.reason)) ||
        command.expectedVersion !== approval.policyVersion) return;
    submittingRef.current = true;
    setSubmitting(true);
    const wasUncertain = approvalAttempts.get(approvalId)?.key === command.key;
    const generation = formGeneration.current;
    let sent = false;
    let restoreConfirmation = false;
    setConfirmation(undefined);
    setPassword('');
    setReason('');
    setNotice('');
    try {
      if (sensitive) {
        const [workspace] = await Promise.all([apiClient.getCurrentWorkspace(), refresh(true)]);
        if (!isSessionActive() || generation !== formGeneration.current) return;
        if (!workspace.capabilities.includes('approvals.review') ||
            !workspace.capabilities.includes(APPROVAL_REAUTH_CAPABILITY)) {
          setNotice('La verificación de esta decisión ya no está disponible.');
          void refreshApprovalList(true, true);
          return;
        }
        const current = lastRead.current;
        if (!current || current.policyVersion !== command.expectedVersion ||
            !requiresApprovalReauthentication(current.risk) || !canDecideMobileApproval(current, Date.now(), true)) {
          setNotice('Revisa el estado actual de la solicitud antes de confirmar.');
          return;
        }
      }
      approvalAttempts.set(approvalId, command);
      setAttempt(command);
      sent = true;
      const result = await apiClient.decideApproval(command, credential);
      if (!isSessionActive()) return;
      clearAttempt(command);
      setApproval((current) => current && {
        ...current, status: result.status, policyVersion: Math.max(current.policyVersion, command.expectedVersion + 1),
      });
      void refreshApprovalList(false, true);
      setNotice(result.status === 'approved' ? 'La aprobación se registró.' : 'El rechazo se registró.');
    } catch (cause) {
      if (!isSessionActive()) return;
      const reauthFailure = sensitive && cause instanceof MobileApiError ? reauthenticationError(cause) : undefined;
      if (reauthFailure && cause instanceof MobileApiError) {
        if (!wasUncertain) clearAttempt(command);
        if (cause.status === 429 && cause.retryAfterSeconds) {
          setRetryAllowedAt(Date.now() + Math.min(cause.retryAfterSeconds, 86_400) * 1000);
        }
        restoreConfirmation = !wasUncertain;
        setNotice(reauthFailure);
      } else if (!sent) {
        restoreConfirmation = !wasUncertain;
        setNotice('No se pudo verificar el acceso para registrar la decisión.');
      } else if (cause instanceof MobileApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
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
      const current = lastRead.current;
      if (restoreConfirmation && isSessionActive() && generation === formGeneration.current && current &&
          current.policyVersion === command.expectedVersion &&
          canDecideMobileApproval(current, Date.now(), reauthenticationSupported)) {
        review(command);
      }
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function confirm() {
    if (!approval || !confirmation || submittingRef.current) return;
    if (!canDecide || approval.policyVersion !== confirmation.expectedVersion) {
      setConfirmation(undefined);
      setPassword('');
      setNotice('La solicitud cambió o venció. Actualiza el detalle antes de decidir.');
      return;
    }
    const existing = approvalAttempts.get(approvalId);
    if (existing && existing.key !== confirmation.key) {
      setAttempt(existing);
      setConfirmation(undefined);
      setPassword('');
      return;
    }
    if (!sensitive) {
      void submit(confirmation);
      return;
    }
    const explanation = confirmation.reason ?? reason.trim();
    if (!password || !explanation || explanation.length > MAX_APPROVAL_REASON_LENGTH || reauthLimited) return;
    void submit({ ...confirmation, reason: explanation }, password);
  }

  async function retry(command: MobileApprovalCommand) {
    if (checkingRef.current || submittingRef.current || !canDecide || reauthLimited) return;
    if (!sensitive) {
      void submit(command);
      return;
    }
    checkingRef.current = true;
    setChecking(true);
    const generation = formGeneration.current;
    try {
      await refresh(true);
      if (!isSessionActive() || generation !== formGeneration.current ||
          approvalAttempts.get(approvalId)?.key !== command.key) return;
      const current = lastRead.current;
      if (current && current.policyVersion === command.expectedVersion &&
          canDecideMobileApproval(current, Date.now(), reauthenticationSupported) && command.reason) {
        review(command);
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  const expired = approval?.status === 'pending' && Date.parse(approval.expiresAt) <= Date.now();

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="Detalle de aprobación" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
            {approval.status === 'pending' && !expired && sensitive ? (
              <Text accessibilityRole="alert" style={styles.alert}>
                {reauthenticationSupported
                  ? 'Esta decisión sensible requiere tu contraseña actual y un motivo.'
                  : 'Esta decisión sensible requiere verificación. El servidor debe ofrecerla por HTTPS.'}
              </Text>
            ) : null}
            {approval.status === 'pending' && !expired && !sensitive && !canReviewRiskOnMobile(approval.risk) ? (
              <Text accessibilityRole="alert" style={styles.alert}>No se pudo verificar el nivel de riesgo. La decisión está bloqueada.</Text>
            ) : null}
            {attempt && !submitting && !confirmation ? (
              <View style={styles.card}>
                <Text accessibilityRole="alert" style={styles.alert}>Hay una decisión sin confirmar en esta sesión.</Text>
                <Action label={checking ? 'Comprobando estado…' : 'Reintentar la misma decisión'}
                  disabled={!canDecide || checking || reauthLimited || approval.policyVersion !== attempt.expectedVersion}
                  onPress={() => void retry(attempt)} />
              </View>
            ) : null}
            {confirmation ? (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  {confirmation.decision === 'approved' ? '¿Confirmar aprobación?' : '¿Confirmar rechazo?'}
                </Text>
                <Text style={styles.secondary}>La decisión se registrará con tu cuenta.</Text>
                {sensitive ? (
                  <>
                    <Text style={styles.secondary}>Motivo obligatorio</Text>
                    <TextInput accessibilityLabel="Motivo de la decisión" value={reason} onChangeText={setReason}
                      editable={confirmation.reason === undefined} maxLength={MAX_APPROVAL_REASON_LENGTH} multiline
                      style={[styles.input, styles.reason]} />
                    <Text style={styles.secondary}>Contraseña actual</Text>
                    <TextInput accessibilityLabel="Contraseña actual" value={password} onChangeText={setPassword}
                      secureTextEntry autoComplete="off" textContentType="none" importantForAutofill="no"
                      autoCapitalize="none" autoCorrect={false} style={styles.input} />
                  </>
                ) : null}
                <View style={styles.actions}>
                  <Action label="Cancelar" onPress={() => { setConfirmation(undefined); setPassword(''); setReason(''); }} />
                  <Action label={confirmation.decision === 'approved' ? 'Confirmar aprobación' : 'Confirmar rechazo'}
                    disabled={submitting || !canDecide || (sensitive && (!password || !reason.trim() || reauthLimited))} onPress={confirm} />
                </View>
              </View>
            ) : null}
            {canDecide && !confirmation && !attempt && !submitting ? (
              <View style={styles.actions}>
                <Action label="Aprobar" onPress={() => review({ approvalId, decision: 'approved', expectedVersion: approval.policyVersion, key: uuid.v4() })} />
                <Action label="Rechazar" onPress={() => review({ approvalId, decision: 'rejected', expectedVersion: approval.policyVersion, key: uuid.v4() })} />
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
  input: { minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: colors.border, color: colors.textPrimary, backgroundColor: colors.background, fontSize: 16, padding: 10 },
  reason: { minHeight: 80, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.surfaceLight },
  actionLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
