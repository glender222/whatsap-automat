import React, { useState, useEffect } from 'react';
import { useUserRoleJotai } from '../../jotai/middleware/useUserRoleJotai';
import { useWhatsAppConnection } from './hooks/useWhatsAppConnection';
import { useSocketEvents } from './hooks/useSocketEvents';
import { useSettings } from './hooks/useSettings';
// ❌ LoadingChatsOverlay ELIMINADO - la carga de chats ahora es progresiva en ChatSidebar
import LogoutOverlay from './components/LogoutOverlay';
import SettingsHeader from './components/SettingsHeader';
import SettingsSidebar from './components/SettingsSidebar';
import WhatsAppConnectionSection from './components/WhatsAppConnectionSection';
import ThemeSection from './components/ThemeSection';
import AutoDownloadSection from './components/AutoDownloadSection';
import { CompanyService, type CompanyOverview } from './services/companyService';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Modal principal de configuración
 * Refactorizado en componentes modulares para mejor mantenimiento
 * 
 * NOTA: El overlay de carga de chats ha sido ELIMINADO.
 * La carga de chats ahora es progresiva en segundo plano con animaciones en ChatSidebar.
 */
const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose }) => {
  const { userRole } = useUserRoleJotai();
  const [selectedMenu, setSelectedMenu] = useState('general');

  // Hook de conexión WhatsApp
  const connection = useWhatsAppConnection();

  // Hook de configuraciones
  const settings = useSettings();
  const [companyOverview, setCompanyOverview] = useState<CompanyOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);

  const refreshCompanyOverview = async () => {
    setLoadingOverview(true);
    try {
      setCompanyOverview(await CompanyService.getOverview());
    } catch (error: any) {
      console.warn('No se pudo cargar la configuración WhatsApp Business:', error?.message || error);
    } finally {
      setLoadingOverview(false);
    }
  };

  // Hook de eventos socket
  // NOTA: onLoadingUpdate ya no hace nada porque la carga es progresiva
  useSocketEvents({
    connectionState: connection,
    onLoadingUpdate: () => {
      // No-op: la carga de chats ahora es progresiva en ChatSidebar
    },
    onConnectionUpdate: (updates) => {
      connection.updateState(updates);
    },
    onNumeroDetected: () => {
      connection.fetchNumeroAfiliado();
      // Ya no activamos overlay bloqueante - la carga es progresiva
    }
  });

  // Cargar número afiliado al abrir el modal
  useEffect(() => {
    if (open) {
      connection.fetchNumeroAfiliado();
      refreshCompanyOverview();
    }
    // eslint-disable-next-line
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* ❌ LoadingChatsOverlay ELIMINADO - la carga es progresiva en ChatSidebar */}

      {/* 🔴 Overlay de cierre de sesión */}
      <LogoutOverlay show={connection.showLogoutAnimation} />

      <div
        className="fixed inset-0 z-50 flex items-center justify-center md:p-4"
        style={{ backdropFilter: 'blur(1.5px)' }}
      >
        <div
          onClick={onClose}
          className="fixed inset-0 bg-gray-900 bg-opacity-30 transition-opacity z-40"
        />

        <div
          className="relative z-50 w-full h-full md:h-[680px] md:max-w-4xl bg-white dark:bg-gray-900 md:rounded-2xl shadow-2xl flex flex-col md:flex-row overflow-hidden animate-fadeIn"
          style={{ minHeight: 420 }}
        >
          {/* Header móvil */}
          <SettingsHeader
            selectedMenu={selectedMenu}
            onMenuChange={setSelectedMenu}
            onClose={onClose}
          />

          {/* Sidebar desktop */}
          <SettingsSidebar
            selectedMenu={selectedMenu}
            onMenuChange={setSelectedMenu}
            onClose={onClose}
          />

          {/* Contenido principal */}
          <div className="flex-1 bg-white dark:bg-gray-900 px-4 py-4 md:px-10 md:py-8 overflow-y-auto">
            {selectedMenu === 'general' && (
              <>
                <h2 className="font-semibold text-lg md:text-xl text-gray-900 dark:text-gray-100 mb-4 md:mb-6">General</h2>
                <div className="flex flex-col gap-6 md:gap-8">
                  {/* Número Afiliado */}
                  <WhatsAppConnectionSection
                    numeroAfiliado={connection.numeroAfiliado}
                    afiliando={connection.afiliando}
                    loggingOut={connection.loggingOut}
                    qrUrl={connection.qrUrl}
                    companyOverview={companyOverview}
                    loadingOverview={loadingOverview}
                    canManageConnection={userRole === 'ADMIN'}
                    onConnectionSaved={refreshCompanyOverview}
                    onAfiliar={userRole === 'ADMIN' ? connection.handleAfiliar : undefined}
                    onDesafiliar={userRole === 'ADMIN' ? connection.handleDesafiliar : undefined}
                  />

                  {/* Tema */}
                  <ThemeSection />

                  {/* Descargas automáticas */}
                  <AutoDownloadSection
                    autoDownloadImagesFiles={settings.autoDownloadImagesFiles}
                    autoDownloadDocuments={settings.autoDownloadDocuments}
                    onImagesFilesChange={(value) =>
                      settings.updateSettings({ autoDownloadImagesFiles: value })
                    }
                    onDocumentsChange={(value) =>
                      settings.updateSettings({ autoDownloadDocuments: value })
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default SettingsModal;
