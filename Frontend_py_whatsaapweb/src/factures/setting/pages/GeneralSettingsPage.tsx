import React, { useEffect, useState } from 'react';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';
import { useWhatsAppConnection } from '../hooks/useWhatsAppConnection';
import { useSettings } from '../hooks/useSettings';
import { CompanyService, type CompanyOverview } from '../services/companyService';
import WhatsAppConnectionSection from '../components/WhatsAppConnectionSection';
import ThemeSection from '../components/ThemeSection';
import AutoDownloadSection from '../components/AutoDownloadSection';

const GeneralSettingsPage: React.FC = () => {
  const { userRole } = useUserRoleJotai();
  
  // Hook de conexión WhatsApp
  const connection = useWhatsAppConnection();
  
  // Hook de configuraciones
  const settings = useSettings();
  const [companyOverview, setCompanyOverview] = useState<CompanyOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);

  const refreshCompanyOverview = async () => {
    setLoadingOverview(true);
    try {
      setCompanyOverview(await CompanyService.getOverview());
    } catch (error: any) {
      console.warn('No se pudo cargar la empresa WhatsApp:', error?.message || error);
    } finally {
      setLoadingOverview(false);
    }
  };

  // Cargar número afiliado al montar
  useEffect(() => {
    connection.fetchNumeroAfiliado();
    refreshCompanyOverview();
    // eslint-disable-next-line
  }, []);

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900">
      {/* Contenido principal */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-8">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 md:p-8">
          <div className="flex flex-col gap-8">
            {/* WhatsApp Business */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                WhatsApp Business
              </h2>
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
            </div>

            <hr className="border-gray-200 dark:border-gray-700" />

            {/* Tema */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Apariencia
              </h2>
              <ThemeSection />
            </div>

            <hr className="border-gray-200 dark:border-gray-700" />

            {/* Descargas automáticas */}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Descargas Automáticas
              </h2>
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

          </div>
        </div>
      </div>
    </div>
  );
};

export default GeneralSettingsPage;
