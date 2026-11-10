import { atom } from 'jotai';
import { readSession } from '../../shared/auth/session';
import type { UserRole } from '../../shared/types/user.types';

// Atom para el rol actual del usuario
export const userRoleAtom = atom<UserRole | null>(null);

// Service para sincronizar el rol con localStorage
export const setUserRole = (role: UserRole) => {
  localStorage.setItem('userRole', role);
};

export const getUserRole = (): UserRole | null => {
  const role = readSession().user?.rol ?? localStorage.getItem('userRole');
  if (role === 'ADMIN' || role === 'EMPLEADO') return role;
  return null;
};

export const clearUserRole = () => {
  localStorage.removeItem('userRole');
};
