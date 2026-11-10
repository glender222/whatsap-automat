import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { apiClient, MobileApiError, type MobileApproval } from './apiClient';
import { observeApprovalAlerts } from './approvalAlerts';
import { APPROVAL_REAUTH_CAPABILITY } from './approvalPolicy';
import { useSession } from './sessionContext';

interface ApprovalFeed {
  canReview: boolean;
  canReauthenticate: boolean;
  page: MobileApproval[];
  loading: boolean;
  error: string;
  alertIds: string[];
}

const initialFeed: ApprovalFeed = { canReview: false, canReauthenticate: false, page: [], loading: true, error: '', alertIds: [] };
const accessError = 'Tu espacio de trabajo no permite revisar aprobaciones.';
const ApprovalFeedContext = createContext<(ApprovalFeed & {
  refresh: (verifyAccess?: boolean, requireFresh?: boolean) => Promise<void>;
  dismiss: (id: string) => void;
}) | null>(null);

function isForeground() {
  return !AppState.currentState || AppState.currentState === 'active' || AppState.currentState === 'unknown';
}

export function ApprovalFeedProvider({ children }: React.PropsWithChildren) {
  const { isSessionActive } = useSession();
  const [feed, setFeed] = useState(initialFeed);
  const access = useRef<boolean | null>(null);
  const cursor = useRef<ReturnType<typeof observeApprovalAlerts>['cursor'] | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const generation = useRef(0);

  const refresh = useCallback((verifyAccess = false, requireFresh = false): Promise<void> => {
    if (!isSessionActive() || !isForeground()) return Promise.resolve();
    if (inFlight.current) {
      return requireFresh ? inFlight.current.then(() => refresh(verifyAccess)) : inFlight.current;
    }
    const started = generation.current;
    const isCurrent = () => isSessionActive() && isForeground() && started === generation.current;
    const deny = () => {
      access.current = false;
      cursor.current = undefined;
      setFeed({ ...initialFeed, loading: false, error: accessError });
    };
    const request = (async () => {
      try {
        if (verifyAccess || access.current === null) {
          const workspace = await apiClient.getCurrentWorkspace();
          if (!isCurrent()) return;
          if (!workspace.capabilities.includes('approvals.review')) {
            deny();
            return;
          }
          access.current = true;
          const canReauthenticate = workspace.capabilities.includes(APPROVAL_REAUTH_CAPABILITY);
          setFeed((current) => ({ ...current, canReview: true, canReauthenticate, error: '' }));
        }
        if (access.current !== true) return;
        const page = await apiClient.listApprovals();
        if (!isCurrent()) return;
        const observations = observeApprovalAlerts(cursor.current, page);
        cursor.current = observations.cursor;
        setFeed((current) => ({
          ...current, canReview: true, page, loading: false, error: '',
          alertIds: [...new Set([...observations.newIds, ...current.alertIds])]
            .filter((id) => observations.pendingIds.has(id)),
        }));
      } catch (cause) {
        if (!isCurrent()) return;
        if (cause instanceof MobileApiError && cause.status === 403) {
          deny();
        } else {
          setFeed((current) => ({ ...current, loading: false, error: 'No se pudo cargar la lista de aprobaciones.' }));
        }
      }
    })().finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    inFlight.current = request;
    return request;
  }, [isSessionActive]);

  useEffect(() => {
    let active = isForeground();
    let mounted = true;
    void (inFlight.current ?? Promise.resolve()).then(() => {
      if (mounted) void refresh(true);
    });
    const interval = setInterval(() => {
      if (access.current !== false) void refresh();
    }, 15_000);
    const subscription = AppState.addEventListener('change', () => {
      const next = isForeground();
      if (next === active) return;
      active = next;
      generation.current++;
      if (next) void (inFlight.current ?? Promise.resolve()).then(() => {
        if (mounted && active) void refresh(true);
      });
    });
    return () => {
      mounted = false;
      generation.current++;
      clearInterval(interval);
      subscription.remove();
    };
  }, [refresh]);

  const dismiss = useCallback((id: string) => {
    setFeed((current) => ({ ...current, alertIds: current.alertIds.filter((entry) => entry !== id) }));
  }, []);

  return <ApprovalFeedContext.Provider value={{ ...feed, refresh, dismiss }}>{children}</ApprovalFeedContext.Provider>;
}

export function useApprovalFeed() {
  const feed = useContext(ApprovalFeedContext);
  if (!feed) throw new Error('La lista de aprobaciones requiere una sesión iniciada.');
  return feed;
}
