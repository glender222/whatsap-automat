// src/factures/mensajeria/types/tagTypes.ts

export interface Tag {
  id: string;
  name: string;
  color?: string | null; // puede ser una clase tailwind (text-green-500) o un hex (#ff0000)
  owner_id?: string | number | null;
  is_default?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TagCreate {
  name: string;
  color?: string | null;
}

export interface TagUpdate {
  name?: string;
  color?: string | null;
}

export type TagsResponse = Tag[];
