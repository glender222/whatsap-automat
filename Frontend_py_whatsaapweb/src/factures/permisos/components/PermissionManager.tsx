// src/factures/permisos/components/PermissionManager.tsx

import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { Tag as TagIcon, Check, X, Search, Loader2 } from 'lucide-react';
import { EmployeeTagService } from '../services/employeeTagService';
import type { Tag } from '../../mensajeria/types/tagTypes';

interface EmployeeTagManagerProps {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
  onSuccess: () => void;
}

function tagSwatchClass(color?: string | null): string {
  if (!color) return 'bg-gray-400';
  if (color.startsWith('bg-')) return color;
  if (color.startsWith('text-')) return color.replace(/^text-/, 'bg-');
  return '';
}

function tagSwatchStyle(color?: string | null): CSSProperties | undefined {
  return color && color.startsWith('#') ? { backgroundColor: color } : undefined;
}

export function PermissionManager({ 
  employeeId, 
  employeeName, 
  onClose, 
  onSuccess 
}: EmployeeTagManagerProps) {
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [assignedTagIds, setAssignedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [employeeId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // ✅ Obtener TODOS los tags disponibles
      const tags = await EmployeeTagService.getAllTagsForEmployees();
      console.log('📋 Tags disponibles para empleados:', tags.length);
      
      // Obtener tags del empleado específico
      // Usando la lógica: revisamos cada tag para ver si el empleado está asignado
      const assignedIds: string[] = [];
      for (const tag of tags) {
        const employees = await EmployeeTagService.getEmployeesWithTag(tag.id);
        const isAssigned = employees.some((emp: any) => emp.id === employeeId || emp.employee_id === employeeId);
        if (isAssigned) {
          assignedIds.push(tag.id);
        }
      }
      
      console.log('✅ Tags del empleado:', assignedIds.length);
      
      setAvailableTags(tags);
      setAssignedTagIds(assignedIds);
    } catch (error: any) {
      console.error('Error loading data:', error);
      alert(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const hasTag = (tagId: string): boolean => {
    return assignedTagIds.includes(tagId);
  };

  const toggleTag = async (tagId: string) => {
    setUpdating(tagId);
    try {
      const currentlyHasTag = hasTag(tagId);
      
      if (currentlyHasTag) {
        await EmployeeTagService.revokeTagFromEmployee({ employeeId, tagId });
        setAssignedTagIds(prev => prev.filter(id => id !== tagId));
      } else {
        await EmployeeTagService.assignTagToEmployee({ employeeId, tagId });
        setAssignedTagIds(prev => [...prev, tagId]);
      }
      
      onSuccess();
    } catch (error: any) {
      console.error('Error toggling tag:', error);
      alert(error.message || 'Error al actualizar tag');
      // Recargar datos si hay error
      await loadData();
    } finally {
      setUpdating(null);
    }
  };

  const filteredTags = availableTags.filter(tag =>
    tag.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 flex items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-600 dark:text-emerald-400" />
          <span className="text-gray-700 dark:text-gray-300 font-medium">Cargando...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col animate-scale-in">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Gestionar Etiquetas</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Asigna etiquetas para <span className="font-semibold text-emerald-600 dark:text-emerald-400">{employeeName}</span>
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="px-6 py-4 bg-gradient-to-r from-emerald-50 to-emerald-50/50 dark:from-emerald-900/30 dark:to-emerald-800/30 border-b border-emerald-100 dark:border-emerald-700">
          <div className="flex items-center gap-6">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Etiquetas asignadas</p>
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{assignedTagIds.length}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Total de etiquetas</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{availableTags.length}</p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500 w-5 h-5" />
            <input
              type="text"
              placeholder="Buscar etiquetas..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-4 py-3 border-2 border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-emerald-500 dark:focus:border-emerald-400 transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            />
          </div>
        </div>

        {/* Tag List */}
        <div className="flex-1 overflow-y-auto p-6">
          {filteredTags.length === 0 ? (
            <div className="text-center py-12">
              <TagIcon className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
              <p className="text-gray-500 dark:text-gray-400">No se encontraron etiquetas</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTags.map((tag) => {
                const isAssigned = hasTag(tag.id);
                const isUpdating = updating === tag.id;

                return (
                  <div
                    key={tag.id}
                    className={`flex items-center justify-between p-4 rounded-xl border-2 transition-all ${
                      isAssigned
                        ? 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-700'
                        : 'bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`w-4 h-4 rounded-full ${tagSwatchClass(tag.color)}`}
                        style={tagSwatchStyle(tag.color)}
                      ></div>
                      <div>
                        <h4 className="font-semibold text-gray-900 dark:text-gray-100">{tag.name}</h4>
                      </div>
                    </div>

                    <button
                      onClick={() => toggleTag(tag.id)}
                      disabled={isUpdating}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-all ${
                        isAssigned
                          ? 'bg-red-500 hover:bg-red-600 text-white'
                          : 'bg-emerald-500 hover:bg-emerald-600 text-white'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {isUpdating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : isAssigned ? (
                        <>
                          <X className="w-4 h-4" />
                          Revocar
                        </>
                      ) : (
                        <>
                          <Check className="w-4 h-4" />
                          Asignar
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
          <button
            onClick={onClose}
            className="w-full bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 text-gray-700 dark:text-gray-200 py-3 rounded-xl font-semibold transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
