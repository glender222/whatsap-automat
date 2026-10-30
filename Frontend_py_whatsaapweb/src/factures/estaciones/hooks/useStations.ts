import { useState, useEffect } from 'react';
import { EmployeeService } from '../services/employeeService';
import { EmployeeTagService } from '../../permisos/services/employeeTagService';
import type { Employee } from '../types/Employee';
import type { Station } from '../types/Station';

export function useStations() {
  const [currentUser, setCurrentUser] = useState<Employee | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<{ id: string; name: string; is_default?: boolean }[]>([]);
  const [employeeTags, setEmployeeTags] = useState<Record<string, string[]>>({});

  const loadData = async () => {
    setLoading(true);
    try {
      const userRes = await EmployeeService.getCurrentUser();
      setCurrentUser(userRes.data);
      // Obtener empleados si el usuario es ADMIN
      if (userRes.data.rol === 'ADMIN') {
        const empRes = await EmployeeService.getAll();
        setEmployees(empRes.data);
      } else {
        setEmployees([]);
      }

      // Obtener todas las etiquetas disponibles (misma lógica que PermissionsPage)
      try {
        const allTags = await EmployeeTagService.getAllTagsForEmployees();
        if (Array.isArray(allTags)) setTags(allTags.map((t: any) => ({ id: t.id, name: t.name, is_default: t.is_default })));

        // Si es ADMIN, construir mapa empleadoId -> [tagName] consultando /tags/:id/users por cada tag
        if (userRes.data.rol === 'ADMIN') {
          try {
            const tagResults = await Promise.all(
              allTags.map(async (tag: any) => {
                try {
                  const emps = await EmployeeTagService.getEmployeesWithTag(tag.id);
                  return { tag, emps };
                } catch (err) {
                  return { tag, emps: [] };
                }
              })
            );

            const map: Record<string, string[]> = {};
            tagResults.forEach(({ tag, emps }: any) => {
              (emps || []).forEach((emp: any) => {
                const id = emp.id || emp.employee_id;
                if (!id) return;
                if (!map[id]) map[id] = [];
                if (tag?.name && !map[id].includes(tag.name)) map[id].push(tag.name);
              });
            });

            setEmployeeTags(map);
          } catch (err: any) {
            console.error('useStations.loadData building employeeTags map error', err);
          }
        }
      } catch (tagErr: any) {
        console.error('useStations.loadData getAllTagsForEmployees error', tagErr);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Error al cargar estaciones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Generar estaciones: primero el usuario logueado, luego los empleados
  // Nombres de etiquetas para asignar a las estaciones (fallback a ['Todo'])
  const currentTagNames: string[] = tags && tags.length ? tags.map(t => t.name) : ['Todo'];

  const stations: Station[] = [
    ...(currentUser ? [{
      id: currentUser.id,
      nombre: `PC ${currentUser.nombre}`,
      estado: 'Disponible',
      rol: currentUser.rol,
      etiquetasBot: currentTagNames,
      email: currentUser.email
    }] : []),
    ...employees.filter(e => e.id !== currentUser?.id).map(e => ({
      id: e.id,
      nombre: `PC ${e.nombre}`,
      estado: 'Disponible',
      rol: e.rol,
      etiquetasBot: employeeTags[e.id] || [],
      email: e.email
    }))
  ];

  const refreshEmployees = async () => {
    if (currentUser?.rol === 'ADMIN') {
      try {
        const empRes = await EmployeeService.getAll();
        setEmployees(empRes.data);
        // refrescar etiquetas: obtener todas las tags y reconstruir el mapa empleado->tags
        try {
          const allTags = await EmployeeTagService.getAllTagsForEmployees();
          if (Array.isArray(allTags)) setTags(allTags.map((t: any) => ({ id: t.id, name: t.name, is_default: t.is_default })));

          const tagResults = await Promise.all(
            allTags.map(async (tag: any) => {
              try {
                const emps = await EmployeeTagService.getEmployeesWithTag(tag.id);
                return { tag, emps };
              } catch (err) {
                return { tag, emps: [] };
              }
            })
          );

          const map: Record<string, string[]> = {};
          tagResults.forEach(({ tag, emps }: any) => {
            (emps || []).forEach((emp: any) => {
              const id = emp.id || emp.employee_id;
              if (!id) return;
              if (!map[id]) map[id] = [];
              if (tag?.name && !map[id].includes(tag.name)) map[id].push(tag.name);
            });
          });

          setEmployeeTags(map);
        } catch (err: any) {
          console.error('useStations.refreshEmployees building employeeTags map error', err);
        }
      } catch (err: any) {
        setError(err?.response?.data?.error || 'Error al actualizar empleados');
      }
    }
  };

  return {
    currentUser,
    employees,
    stations,
    loading,
    error,
    refreshEmployees,
    clearError: () => setError(null)
  };
}