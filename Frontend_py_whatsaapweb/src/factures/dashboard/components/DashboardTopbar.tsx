import { User } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

export default function DashboardTopbar() {
  const location = useLocation();
  const { user } = useAuthJotai();
  const { userRole } = useUserRoleJotai();

  const userName = user?.nombre || user?.email || 'Usuario';
  const userRoleDisplay = userRole === 'ADMIN' ? 'Administrador' : 'Empleado';
  const pageTitle = location.pathname.startsWith('/dashboard/catalogos')
    ? 'Gestionar catalogos'
    : location.pathname.startsWith('/dashboard/pagos')
      ? 'Validar Pagos'
      : location.pathname.startsWith('/dashboard/handoff')
        ? 'Cola de Handoff'
        : location.pathname.startsWith('/dashboard/ia')
          ? 'Dominios IA'
          : location.pathname.startsWith('/dashboard/inventario')
            ? 'Productos del catalogo'
            : 'Administracion';

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{pageTitle}</h1>

        <div className="flex items-center space-x-3">
          <div className="text-right">
            <p className="text-sm font-medium text-gray-900">{userName}</p>
            <p className="text-xs text-gray-500">{userRoleDisplay}</p>
          </div>
          <div className="w-10 h-10 bg-gradient-to-br from-teal-400 to-teal-600 rounded-full flex items-center justify-center">
            <User className="w-6 h-6 text-white" />
          </div>
        </div>
      </div>
    </header>
  );
}
