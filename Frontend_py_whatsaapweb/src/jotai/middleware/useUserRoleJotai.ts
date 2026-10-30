import { useAtom } from 'jotai';
import { userRoleAtom, setUserRole, getUserRole, clearUserRole } from './userRoleAtom';
import type { UserRole } from '../../shared/types/user.types';

export function useUserRoleJotai() {
  const [userRole, setUserRoleAtom] = useAtom(userRoleAtom);

  // Guardar rol en jotai y localStorage
  const saveUserRole = (role: UserRole) => {
    setUserRoleAtom(role);
    setUserRole(role);
  };

  // Leer rol desde localStorage y sincronizar con jotai
  const syncUserRole = () => {
    const role = getUserRole();
    setUserRoleAtom(role);
    return role;
  };

  // Limpiar rol
  const clearUserRoleAll = () => {
    setUserRoleAtom(null);
    clearUserRole();
  };

  return {
    userRole,
    saveUserRole,
    syncUserRole,
    clearUserRole: clearUserRoleAll,
  };
}
