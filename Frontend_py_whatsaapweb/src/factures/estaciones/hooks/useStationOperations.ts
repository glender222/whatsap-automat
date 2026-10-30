import { EmployeeService } from '../services/employeeService';
import type { Station } from '../types/Station';

export function useStationOperations(refreshEmployees: () => Promise<void>, showToast: (message: string) => void) {
  
  const handleCreateStation = async (nombre: string, email: string, password?: string) => {
    try {
      const response = await EmployeeService.createStation(nombre, email, password);
      
      if (response.success && response.data.tempPassword) {
        const pwd = response.data.tempPassword;
        
        alert(
          `✅ Estación creada exitosamente!\n\n` +
          `📧 Email: ${email}\n` +
          `🔑 Contraseña: ${pwd}\n\n` +
          `⚠️ IMPORTANTE: Guarda esta contraseña, no se volverá a mostrar.\n` +
          `El empleado debe cambiarla en su primer inicio de sesión.`
        );
      }
      
      await refreshEmployees();
      showToast('✅ Nueva estación creada exitosamente');
    } catch (err: any) {
      if (err.message && err.message.includes('permisos')) {
        showToast('❌ No tienes permisos para crear estaciones');
      } else {
        showToast(err?.response?.data?.error || err.message || 'Error al crear estación');
      }
      throw err;
    }
  };

  const handleEditStation = async (id: string, nombre: string, email: string) => {
    try {
      await EmployeeService.updateEmployee(id, { nombre, email });
      await refreshEmployees();
      showToast('✅ Estación actualizada exitosamente');
    } catch (err: any) {
      showToast(err?.message || 'Error al actualizar estación');
      throw err;
    }
  };

  const handleChangePassword = async (id: string, newPassword: string) => {
    try {
      await EmployeeService.changeEmployeePassword(id, newPassword);
      showToast('✅ Contraseña actualizada exitosamente');
    } catch (err: any) {
      showToast(err?.message || 'Error al cambiar contraseña');
      throw err;
    }
  };

  const handleDeleteStation = async (station: Station) => {
    const confirmed = window.confirm(`¿Eliminar la estación "${station.nombre}"? El usuario ya no podrá iniciar sesión.`);
    if (!confirmed) return;

    try {
      await EmployeeService.deleteEmployee(station.id);
      await refreshEmployees();
      showToast('✅ Estación eliminada exitosamente');
    } catch (err: any) {
      showToast(err?.response?.data?.error || err.message || 'Error al eliminar estación');
      throw err;
    }
  };

  return {
    handleCreateStation,
    handleEditStation,
    handleChangePassword,
    handleDeleteStation
  };
}
