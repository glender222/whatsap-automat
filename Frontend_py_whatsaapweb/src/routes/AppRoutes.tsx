import { useUserRoleJotai } from '../jotai/middleware/useUserRoleJotai';
import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import GestionWeb from "../factures/GestionWeb";
import LandingPage from "../factures/landing/pages/LandingPage";
import SocketService from "../utils/socket";

// Auth pages
import LoginPage from "../factures/auth/pages/LoginPage";
import RegisterPage from "../factures/auth/pages/RegisterPage";
import ForgotPasswordPage from "../factures/auth/pages/ForgotPasswordPage";

// Hijas
import Inicio from "../factures/mensajeria/Inicio";
import Reportes from "../factures/estadisticos/Reportes";
import Seguimiento from "../factures/estaciones/pages/administradorestaciones";
import SettingsPage from "../factures/setting/pages/SettingsPage";
import GeneralSettingsPage from "../factures/setting/pages/GeneralSettingsPage";
import PermissionsPage from "../factures/permisos/pages/PermissionsPage";
import DashboardLayout from "../factures/dashboard/components/DashboardLayout";
import DashboardPage from "../factures/dashboard/pages/DashboardPage";
import PaymentsPage from "../factures/dashboard/pages/PaymentsPage";
import HandoffPage from "../factures/dashboard/pages/HandoffPage";
import AiDomainsPage from "../factures/agentes/pages/AiDomainsPage";
import AgentsPage from "../factures/agentes/pages/AgentsPage";
import AgentTestSessionPage from "../factures/agentes/pages/AgentTestSessionPage";
import CatalogsPage from "../factures/inventario/pages/CatalogsPage";
import InventoryPage from "../factures/inventario/pages/InventoryPage";
import { useAgentState } from "../factures/dashboard/hooks/useAgentState";

import { authService } from "../factures/auth/services/authService";

function PrivateRoute({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
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
  const {  syncUserRole } = useUserRoleJotai();
  useAgentState();
  React.useEffect(() => { syncUserRole(); }, []);
  const location = useLocation();
  const state = location.state as { background?: any } | undefined;
  const background = state && state.background;

  // 🔌 Inicializar Socket.IO una sola vez cuando el usuario está autenticado
  React.useEffect(() => {
    const token = localStorage.getItem('accessToken');
    
    if (token) {
      console.log('🔌 Inicializando Socket.IO en nivel superior de la app...');
      const socketService = SocketService.getInstance();
      socketService.connect();
    }

    return () => {
      // NO desconectar al desmontar, ya que la sesión continúa
    };
  }, []); // Se ejecuta solo una vez al montar

  return (
    <>
      <Routes location={background || location}>
        <Route path="/" element={<LandingPage />} />

        {/* Auth routes */}
        <Route path="/auth/login" element={<LoginPage />} />
        <Route path="/auth/register" element={<RegisterPage />} />
        <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />

        {/* Admin Panel - Ruta independiente */}
        <Route
          path="/dashboard/*"
          element={
            <PrivateRoute>
              <DashboardLayout />
            </PrivateRoute>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="" element={<DashboardPage />} />
          <Route path="pagos" element={<PaymentsPage />} />
          <Route path="handoff" element={<HandoffPage />} />
          <Route path="ia/dominios" element={<PrivateRoute adminOnly><AiDomainsPage /></PrivateRoute>} />
          <Route path="ia-settings" element={<Navigate to="/dashboard/ia/dominios" replace />} />
          <Route path="ia/agentes" element={<PrivateRoute adminOnly><AgentsPage /></PrivateRoute>} />
          <Route path="ia/agentes/test" element={<PrivateRoute adminOnly><AgentTestSessionPage /></PrivateRoute>} />
          <Route path="agentes" element={<Navigate to="/dashboard/ia/agentes" replace />} />
          <Route path="inventario" element={<InventoryPage />} />
          <Route path="catalogos" element={<CatalogsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>

        {/* Rutas protegidas */}
        <Route
          path="/gestion-web/*"
          element={
            <PrivateRoute>
              <GestionWeb />
            </PrivateRoute>
          }
        >
          <Route index element={<Navigate to="/gestion-web/inicio" replace />} />
          <Route path="inicio" element={<Inicio />} />
          <Route path="reportes" element={<div className="max-w-7xl mx-auto h-full"><Reportes /></div>} />
          
        <Route
          path="administrar-estaciones"
          element={<Seguimiento />}
        />
          <Route path="permisos" element={<PrivateRoute adminOnly><PermissionsPage /></PrivateRoute>} />
          <Route path="*" element={<Navigate to="/gestion-web/inicio" replace />} />
        </Route>
      </Routes>

      {background && (
        <Routes>
          <Route path="/gestion-web/settings" element={<SettingsPage />} />
          <Route path="/gestion-web/settings/general" element={<GeneralSettingsPage />} />
        </Routes>
      )}
    </>
  );
}

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <AppRoutesInner />
    </BrowserRouter>
  );
}
