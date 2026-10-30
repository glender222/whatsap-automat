import { useState, useEffect, useCallback } from 'react';
import type { Tag } from '../types/tagTypes';
import * as tagsService from '../services/tagsService';

/**
 * Hook para gestionar etiquetas (tags)
 * Principio de Responsabilidad Única: Solo maneja la lógica de etiquetas
 */
export function useTagsManagement() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('Seleccione');
  const [categoryInitialized, setCategoryInitialized] = useState(false);

  // Cargar etiquetas desde la API
  useEffect(() => {
    let mounted = true;
    
    async function loadTags() {
      try {
        const data = await tagsService.getTags();
        if (!mounted) return;
        setTags(data || []);
      } catch (err) {
        console.warn('No se pudieron cargar las etiquetas:', err);
      }
    }
    
    loadTags();
    return () => { mounted = false; };
  }, []);

  // Seleccionar etiqueta por prioridad (SOLO LA PRIMERA VEZ)
  useEffect(() => {
    if (categoryInitialized) return;

    if (tags.length === 0) {
      setSelectedCategory('Seleccione');
      return;
    }

    // Priorizar etiqueta "Todo" si existe
    const todoTag = tags.find(t => t.name === 'Todo');
    if (todoTag) {
      setSelectedCategory('Todo');
      setCategoryInitialized(true);
      return;
    }

    // Si no hay "Todo", seleccionar la primera
    setSelectedCategory(tags[0].name);
    setCategoryInitialized(true);
  }, [tags, categoryInitialized]);

  // Crear una nueva etiqueta
  const handleCreateTag = useCallback(async (data: { name: string; color: string }) => {
    try {
      await tagsService.createTag(data);
      const updatedTags = await tagsService.getTags();
      setTags(updatedTags || []);
    } catch (err) {
      console.error('Error creando etiqueta:', err);
      throw err;
    }
  }, []);

  // Actualizar una etiqueta
  const handleUpdateTag = useCallback(async (id: string, data: { name: string; color: string }) => {
    try {
      await tagsService.updateTag(id, data);
      const updatedTags = await tagsService.getTags();
      setTags(updatedTags || []);
    } catch (err) {
      console.error('Error actualizando etiqueta:', err);
      throw err;
    }
  }, []);

  // Eliminar una etiqueta
  const handleDeleteTag = useCallback(async (id: string) => {
    try {
      await tagsService.deleteTag(id);
      const updatedTags = await tagsService.getTags();
      setTags(updatedTags || []);
    } catch (err) {
      console.error('Error eliminando etiqueta:', err);
      throw err;
    }
  }, []);

  return {
    tags,
    selectedCategory,
    setSelectedCategory,
    handleCreateTag,
    handleUpdateTag,
    handleDeleteTag
  };
}
