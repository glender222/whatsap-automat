import { useState, useEffect } from 'react';
import {
  getAutoDownloadImagesFiles,
  getAutoDownloadDocuments,
  getBotModality,
  setAutoDownloadImagesFiles as saveAutoDownloadImagesFiles,
  setAutoDownloadDocuments as saveAutoDownloadDocuments,
  setBotModality as saveBotModality,
} from '../../../lib/settings';
import type { SettingsState } from '../types/settings.types';

/**
 * Hook para manejar las preferencias de configuración
 * NOTA: El tema ahora se maneja con Jotai (useTheme hook)
 */
export const useSettings = () => {
  const [settings, setSettings] = useState<SettingsState>({
    autoDownloadImagesFiles: false,
    autoDownloadDocuments: false,
    botModality: null
  });

  // Cargar preferencias al montar
  useEffect(() => {
    try {
      setSettings(prev => ({
        ...prev,
        autoDownloadImagesFiles: getAutoDownloadImagesFiles(),
        autoDownloadDocuments: getAutoDownloadDocuments(),
        botModality: getBotModality()
      }));
    } catch (e) {
      console.error('Error loading settings:', e);
    }
  }, []);

  // Guardar cambios automáticamente
  useEffect(() => {
    try {
      saveAutoDownloadImagesFiles(settings.autoDownloadImagesFiles);
    } catch (e) {
      console.error('Error saving autoDownloadImagesFiles:', e);
    }
  }, [settings.autoDownloadImagesFiles]);

  useEffect(() => {
    try {
      saveAutoDownloadDocuments(settings.autoDownloadDocuments);
    } catch (e) {
      console.error('Error saving autoDownloadDocuments:', e);
    }
  }, [settings.autoDownloadDocuments]);

  useEffect(() => {
    try {
      saveBotModality(settings.botModality);
    } catch (e) {
      console.error('Error saving botModality:', e);
    }
  }, [settings.botModality]);

  // Actualizar configuración
  const updateSettings = (updates: Partial<SettingsState>) => {
    setSettings(prev => ({ ...prev, ...updates }));
  };

  return {
    ...settings,
    updateSettings
  };
};
