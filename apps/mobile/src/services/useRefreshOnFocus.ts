import { useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSession } from './sessionContext';

export function useRefreshOnFocus(load: () => Promise<void>) {
  const { isSessionActive } = useSession();
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback((requireFresh = false): Promise<void> => {
    if (!isSessionActive()) return Promise.resolve();
    if (pending.current) return requireFresh ? pending.current.then(() => refresh()) : pending.current;
    const request = load().finally(() => {
      if (pending.current === request) pending.current = null;
    });
    pending.current = request;
    return request;
  }, [isSessionActive, load]);

  useFocusEffect(useCallback(() => {
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 15_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]));

  return refresh;
}
