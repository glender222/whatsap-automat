import { useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import type { CustomerHistory } from '../types/customerHistoryTypes';
import { getCustomerHistoryByChat } from '../services/customerHistoryService';

export function useCustomerHistory(chatId: string | null) {
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!chatId) {
      setHistory(null);
      setError(null);
      setLoading(false);
      return;
    }

    const request = new AbortController();
    setLoading(true);
    setError(null);

    getCustomerHistoryByChat(chatId, request.signal)
      .then((data) => {
        if (!request.signal.aborted) setHistory(data);
      })
      .catch((err: unknown) => {
        if (request.signal.aborted) return;
        setHistory(null);
        if (isAxiosError(err) && err.response?.status === 404) {
          setError('Todavia no hay historial para este cliente.');
          return;
        }
        setError(err instanceof Error ? err.message : 'No se pudo cargar el historial.');
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });

    return () => request.abort();
  }, [chatId, reloadToken]);

  return {
    history,
    loading,
    error,
    reload: () => setReloadToken((value) => value + 1),
  };
}
