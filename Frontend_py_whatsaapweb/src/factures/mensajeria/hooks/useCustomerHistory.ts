import { useEffect, useState } from 'react';
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

    let mounted = true;
    setLoading(true);
    setError(null);

    getCustomerHistoryByChat(chatId)
      .then((data) => {
        if (mounted) setHistory(data);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setHistory(null);
        if (err?.response?.status === 404) {
          setError('Todavia no hay historial para este cliente.');
          return;
        }
        setError(err?.response?.data?.message || err?.message || 'No se pudo cargar el historial.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [chatId, reloadToken]);

  return {
    history,
    loading,
    error,
    reload: () => setReloadToken((value) => value + 1),
  };
}
