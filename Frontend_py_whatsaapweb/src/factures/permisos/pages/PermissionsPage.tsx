// src/factures/permisos/pages/PermissionsPage.tsx

import { useState, useEffect } from 'react';
import { Shield, Users, Tag, Search, Key, ChevronRight, Loader2 } from 'lucide-react';
import { EmployeeService } from '../../estaciones/services/employeeService';
import { EmployeeTagService } from '../services/employeeTagService';
import { PermissionManager } from '../components/PermissionManager';
import type { Employee } from '../../estaciones/types/Employee';

interface EmployeeWithTags extends Employee {
  tagCount: number;
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="fixed top-6 right-6 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white px-6 py-4 rounded-xl shadow-2xl z-[9999] flex items-center gap-3 animate-slide-in">
      <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
      <span className="font-medium">{message}</span>
    </div>
  );
}

export default function PermissionsPage() {
  const [employees, setEmployees] = useState<EmployeeWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeWithTags | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadEmployees();
  }, []);

  const loadEmployees = async () => {
    setLoading(true);
    try {
      const response = await EmployeeService.getAll();
      const employeeList = response.data;

      // Obtener todos los tags disponibles
      const allTags = await EmployeeTagService.getAllTagsForEmployees();

      // Cargar el número de etiquetas de cada empleado
      const employeesWithTags = await Promise.all(
        employeeList
          .filter((emp: Employee) => emp.rol === 'EMPLEADO') // Solo mostrar empleados
          .map(async (emp: Employee) => {
            try {
              // Contar cuántos tags tiene este empleado
              let tagCount = 0;
              for (const tag of allTags) {
                const employees = await EmployeeTagService.getEmployeesWithTag(tag.id);
                const hasTag = employees.some((e: any) => e.id === emp.id || e.employee_id === emp.id);
                if (hasTag) tagCount++;
              }
              return {
                ...emp,
                tagCount
              };
            } catch {
              return {
                ...emp,
                tagCount: 0
              };
            }
          })
      );

      setEmployees(employeesWithTags);
    } catch (error) {
      console.error('Error loading employees:', error);
      setToast('Error al cargar empleados');
    } finally {
      setLoading(false);
    }
  };

  const handleManagePermissions = (employee: EmployeeWithTags) => {
    setSelectedEmployee(employee);
  };

  const handleCloseManager = () => {
    setSelectedEmployee(null);
  };

  const handleSuccess = () => {
    setToast('Etiquetas actualizadas correctamente');
    loadEmployees(); // Recargar para actualizar contadores
  };

  const filteredEmployees = employees.filter(emp =>
    emp.nombre.toLowerCase().includes(searchTerm.toLowerCase()) ||
    emp.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-600 dark:text-emerald-400" />
          <span className="text-gray-700 dark:text-gray-300 text-lg font-medium">Cargando empleados...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <style>{`
        @keyframes slide-in {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes scale-in {
          from {
            transform: scale(0.95);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }
        @keyframes fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .animate-slide-in {
          animation: slide-in 0.3s ease-out;
        }
        .animate-scale-in {
          animation: scale-in 0.2s ease-out;
        }
        .animate-fade-in {
          animation: fade-in 0.2s ease-out;
        }
      `}</style>

      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
                <Shield className="w-7 h-7 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Gestión de Etiquetas</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Controla las etiquetas asignadas a empleados
                </p>
              </div>
            </div>

            {/* Stats */}
            <div className="flex gap-4">
              <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/30 px-6 py-3 rounded-xl border border-emerald-200 dark:border-emerald-700">
                <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">Total Empleados</p>
                <p className="text-2xl font-bold text-emerald-900 dark:text-emerald-300">{employees.length}</p>
              </div>
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/30 px-6 py-3 rounded-xl border border-blue-200 dark:border-blue-700">
                <p className="text-xs text-blue-700 dark:text-blue-400 font-medium">Etiquetas Activas</p>
                <p className="text-2xl font-bold text-blue-900 dark:text-blue-300">
                  {employees.reduce((sum, emp) => sum + emp.tagCount, 0)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500 w-5 h-5" />
            <input
              type="text"
              placeholder="Buscar empleados por nombre o email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-4 py-4 border-2 border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-emerald-500 dark:focus:border-emerald-400 transition-colors bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm"
            />
          </div>
        </div>

        {/* Employee Cards */}
        {filteredEmployees.length === 0 ? (
          <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-2xl border-2 border-gray-200 dark:border-gray-600">
            <Users className="w-20 h-20 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">No se encontraron empleados</h3>
            <p className="text-gray-500 dark:text-gray-400">
              {searchTerm ? 'Intenta con otro término de búsqueda' : 'No hay empleados registrados'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredEmployees.map((employee) => (
              <div
                key={employee.id}
                className="bg-white dark:bg-gray-800 rounded-2xl border-2 border-gray-200 dark:border-gray-600 hover:border-emerald-300 dark:hover:border-emerald-500 transition-all duration-300 hover:shadow-xl group"
              >
                <div className="p-6">
                  {/* Employee Info */}
                  <div className="flex items-start gap-4 mb-4">
                    <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-lg">
                      <Users className="w-7 h-7 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">{employee.nombre}</h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{employee.email}</p>
                    </div>
                  </div>

                  {/* Permission Stats */}
                  <div className="bg-gradient-to-r from-emerald-50 to-emerald-50/50 dark:from-emerald-900/30 dark:to-emerald-800/30 rounded-xl p-4 mb-4 border border-emerald-100 dark:border-emerald-700">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Tag className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Etiquetas asignadas</span>
                      </div>
                      <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                        {employee.tagCount}
                      </span>
                    </div>
                  </div>

                  {/* Action Button */}
                  <button
                    onClick={() => handleManagePermissions(employee)}
                    className="w-full bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-200 dark:shadow-emerald-900/50 hover:shadow-xl group-hover:scale-105"
                  >
                    <Key className="w-4 h-4" />
                    Gestionar Etiquetas
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Permission Manager Modal */}
      {selectedEmployee && (
        <PermissionManager
          employeeId={selectedEmployee.id}
          employeeName={selectedEmployee.nombre}
          onClose={handleCloseManager}
          onSuccess={handleSuccess}
        />
      )}

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
