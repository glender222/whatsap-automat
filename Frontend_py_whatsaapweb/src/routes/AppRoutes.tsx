import { lazy, useEffect } from "react";
import { useSetAtom } from "jotai";
import { getUserRole, userRoleAtom } from "../jotai/middleware/userRoleAtom";
import SocketService from "../utils/socket";
import type { ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import LandingPage from "../factures/landing/pages/LandingPage";

// Auth pages
import LoginPage from "../factures/auth/pages/LoginPage";
import RegisterPage from "../factures/auth/pages/RegisterPage";
import ForgotPasswordPage from "../factures/auth/pages/ForgotPasswordPage";

import DashboardLayout from "../factures/dashboard/components/DashboardLayout";
import { useAgentState } from "../factures/dashboard/hooks/useAgentState";
import { authService } from "../factures/auth/services/authService";

const Inicio = lazy(() => import("../factures/mensajeria/Inicio"));
const Reportes = lazy(() => import("../factures/estadisticos/Reportes"));
const Seguimiento = lazy(() => import("../factures/estaciones/pages/administradorestaciones"));
const GeneralSettingsPage = lazy(() => import("../factures/setting/pages/GeneralSettingsPage"));
const PermissionsPage = lazy(() => import("../factures/permisos/pages/PermissionsPage"));
const DashboardPage = lazy(() => import("../factures/dashboard/pages/DashboardPage"));
const PaymentsPage = lazy(() => import("../factures/dashboard/pages/PaymentsPage"));
const OrdersPage = lazy(() => import("../factures/dashboard/orders/OrdersPage"));
const HandoffPage = lazy(() => import("../factures/dashboard/pages/HandoffPage"));
const AiDomainsPage = lazy(() => import("../factures/agentes/pages/AiDomainsPage"));
const AgentsPage = lazy(() => import("../factures/agentes/pages/AgentsPage"));
const AgentTestSessionPage = lazy(() => import("../factures/agentes/pages/AgentTestSessionPage"));
const AgentGraphListPage = lazy(() => import("../components/agent-studio/canonical/AgentGraphListPage"));
const AgentGraphEditorPage = lazy(() => import("../components/agent-studio/canonical/AgentGraphEditorPage"));
const AgentGraphDetailPage = lazy(() => import("../components/agent-studio/canonical/AgentGraphDetailPage"));
const CatalogsPage = lazy(() => import("../factures/inventario/pages/CatalogsPage"));
const InventoryPage = lazy(() => import("../factures/inventario/pages/InventoryPage"));
const CampaignsPage = lazy(() => import("../components/campaigns/CampaignsPage"));
const CampaignWizard = lazy(() => import("../components/campaigns/CampaignWizard"));
const SegmentsManager = lazy(() => import("../components/campaigns/SegmentsManager"));
const MarketplacePage = lazy(() => import("../components/marketplace/MarketplacePage"));
const MarketplaceDetailPage = lazy(() => import("../components/marketplace/MarketplaceDetailPage"));
const WorkflowListPage = lazy(() => import("../components/workflows/WorkflowListPage"));
const WorkflowDetailPage = lazy(() => import("../components/workflows/WorkflowDetailPage"));
const WorkflowEditorPage = lazy(() => import("../components/workflows/WorkflowEditorPage"));
const AuditEventsPage = lazy(() => import("../pages/Admin/AuditEventsPage"));
const SystemHealthPage = lazy(() => import("../pages/Admin/SystemHealthPage"));
const OperationExecutionsPage = lazy(() => import("../pages/Admin/OperationExecutionsPage"));

function PrivateRoute({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }) {
  const isAuth = authService.isAuthenticated();
  const token = localStorage.getItem('accessToken');
  if (!isAuth || !token) return <Navigate to="/auth/login" replace />;
  if (adminOnly) {
    const role = localStorage.getItem('userRole');
    if (role !== 'ADMIN') return <Navigate to="/gestion-web/inicio" replace />;
  }
  return <>{children}</>;
}

function AppRoutesInner() {
  const setUserRole = useSetAtom(userRoleAtom);
  useAgentState();

  useEffect(() => {
    setUserRole(getUserRole());
    if (localStorage.getItem('accessToken')) {
      SocketService.getInstance().connect();
    }
  }, [setUserRole]);

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/auth/login" element={<LoginPage />} />
      <Route path="/auth/register" element={<RegisterPage />} />
      <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />

      <Route element={<PrivateRoute><DashboardLayout /></PrivateRoute>}>
        <Route path="/dashboard">
          <Route index element={<PrivateRoute adminOnly><DashboardPage /></PrivateRoute>} />
          <Route path="pagos" element={<PaymentsPage />} />
          <Route path="pedidos" element={<OrdersPage />} />
          <Route path="handoff" element={<HandoffPage />} />
          <Route path="ia/dominios" element={<PrivateRoute adminOnly><AiDomainsPage /></PrivateRoute>} />
          <Route path="ia-settings" element={<Navigate to="/dashboard/ia/dominios" replace />} />
          <Route path="ia/agentes" element={<PrivateRoute adminOnly><AgentsPage /></PrivateRoute>} />
          <Route path="ia/agentes/test" element={<PrivateRoute adminOnly><AgentTestSessionPage /></PrivateRoute>} />
          <Route path="ia/estudio" element={<PrivateRoute adminOnly><AgentGraphListPage /></PrivateRoute>} />
          <Route path="ia/estudio/nuevo" element={<PrivateRoute adminOnly><AgentGraphEditorPage /></PrivateRoute>} />
          <Route path="ia/estudio/grafos/:graphId" element={<PrivateRoute adminOnly><AgentGraphDetailPage /></PrivateRoute>} />
          <Route path="ia/estudio/grafos/:graphId/revisiones/nueva" element={<PrivateRoute adminOnly><AgentGraphEditorPage /></PrivateRoute>} />
          <Route path="agentes" element={<Navigate to="/dashboard/ia/agentes" replace />} />
          <Route path="inventario" element={<InventoryPage />} />
          <Route path="catalogos" element={<CatalogsPage />} />
          <Route path="campanas" element={<CampaignsPage />} />
          <Route path="campanas/nueva" element={<CampaignWizard />} />
          <Route path="segmentos" element={<SegmentsManager />} />
          <Route path="marketplace" element={<MarketplacePage />} />
          <Route path="marketplace/:extensionId" element={<MarketplaceDetailPage />} />
          <Route path="workflows" element={<WorkflowListPage />} />
          <Route path="workflows/nuevo" element={<PrivateRoute adminOnly><WorkflowEditorPage /></PrivateRoute>} />
          <Route path="workflows/:workflowId" element={<WorkflowDetailPage />} />
          <Route path="workflows/:workflowId/revisiones/nueva" element={<PrivateRoute adminOnly><WorkflowEditorPage /></PrivateRoute>} />
          <Route path="canales/email" element={
            <section className="mx-auto max-w-3xl space-y-2 p-6">
              <h1 className="text-2xl font-semibold">Canal de correo electrónico</h1>
              <p className="text-sm text-gray-600 dark:text-gray-300">La configuración de correo todavía no está disponible desde este espacio de trabajo.</p>
            </section>
          } />
          <Route path="admin/auditoria" element={<PrivateRoute adminOnly><AuditEventsPage /></PrivateRoute>} />
          <Route path="admin/salud" element={<PrivateRoute adminOnly><SystemHealthPage /></PrivateRoute>} />
          <Route path="admin/ejecuciones" element={<PrivateRoute adminOnly><OperationExecutionsPage /></PrivateRoute>} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>

        <Route path="/gestion-web">
          <Route index element={<Navigate to="/gestion-web/inicio" replace />} />
          <Route path="inicio" element={<Inicio />} />
          <Route path="agentes" element={<Navigate to="/dashboard/ia/agentes" replace />} />
          <Route path="reportes" element={<div className="mx-auto h-full max-w-7xl"><Reportes /></div>} />
          <Route path="administrar-estaciones" element={<Seguimiento />} />
          <Route path="permisos" element={<PrivateRoute adminOnly><PermissionsPage /></PrivateRoute>} />
          <Route path="settings" element={<Navigate to="/gestion-web/settings/general" replace />} />
          <Route path="settings/general" element={<GeneralSettingsPage />} />
          <Route path="*" element={<Navigate to="/gestion-web/inicio" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <AppRoutesInner />
    </BrowserRouter>
  );
}
