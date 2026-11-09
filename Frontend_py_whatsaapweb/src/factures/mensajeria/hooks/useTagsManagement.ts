import { useCallback, useEffect, useState } from 'react';
import type { Tag } from '../types/tagTypes';
import * as tagsService from '../services/tagsService';

export function useTagsManagement() {
  const [tags, setTags] = useState<Tag[]>([tagsService.allChatsTag]);
  const [selection, setSelectedTagId] = useState('');
  const [isLoadingTags, setIsLoadingTags] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);

  const reloadTags = useCallback(async () => {
    setIsLoadingTags(true);
    setTagsError(null);
    try {
      const results = await tagsService.getTags();
      setTags([tagsService.allChatsTag, ...results.filter((tag) => !tag.is_default && tag.id !== tagsService.ALL_CHATS_TAG_ID)]);
    } catch (error) {
      setTagsError(error instanceof Error ? error.message : 'No se pudieron cargar las etiquetas.');
    } finally {
      setIsLoadingTags(false);
    }
  }, []);

  useEffect(() => { void reloadTags(); }, [reloadTags]);

  const selectedTagId = tags.some((tag) => tag.id === selection)
    ? selection
    : tagsService.ALL_CHATS_TAG_ID;

  async function handleCreateTag(data: { name: string; color: string }) {
    await tagsService.createTag(data);
    await reloadTags();
  }

  async function handleUpdateTag(id: string, data: { name: string; color: string }) {
    await tagsService.updateTag(id, data);
    await reloadTags();
  }

  async function handleDeleteTag(id: string) {
    await tagsService.deleteTag(id);
    await reloadTags();
  }

  return {
    tags, selectedTagId, setSelectedTagId, isLoadingTags, tagsError, reloadTags,
    handleCreateTag, handleUpdateTag, handleDeleteTag,
  };
}
