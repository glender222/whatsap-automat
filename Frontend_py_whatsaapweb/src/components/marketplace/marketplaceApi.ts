import { isAxiosError } from 'axios';
import { api } from '../../shared/axios/http';

export const marketplacePath = '/dashboard/marketplace';

export const extensionTypes = { channel: 'Canal', tool: 'Herramienta', ui: 'Interfaz' } as const;
export type ExtensionType = keyof typeof extensionTypes;

export interface MarketplaceListing {
  id: string;
  extensionId: string;
  displayName: string;
  version: string;
  type: ExtensionType;
  description: string;
  longDescription?: string;
  author?: string | { name: string };
  license: string;
  categories: string[];
  tags: string[];
  permissions: string[];
  verified: boolean;
  tarballSha256?: string;
  rating: { average: number; count: number };
}

export interface ExtensionReview {
  id: string;
  extensionId: string;
  userId: string;
  score: number;
  review?: string;
  createdAt: string;
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  type?: ExtensionType;
  verified?: true;
  offset: number;
}

interface CatalogResponse {
  items: MarketplaceListing[];
  total: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

const endpoint = '/v1/marketplace/extensions';
export const catalogPageSize = 12;
export const reviewLimit = 1000;

export function ratingLabel({ average, count }: MarketplaceListing['rating']) {
  if (!count) return 'Sin valoraciones';
  const quantity = count === 1 ? '1 valoración' : `${count} valoraciones`;
  return `${average.toLocaleString('es', { maximumFractionDigits: 1 })} de 5 · ${quantity}`;
}

export function isExtensionType(value: string | null): value is ExtensionType {
  return value === 'channel' || value === 'tool' || value === 'ui';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isListing(value: MarketplaceListing | null | undefined): value is MarketplaceListing {
  return Boolean(value && typeof value.id === 'string' && value.id && typeof value.extensionId === 'string' &&
    typeof value.displayName === 'string' && typeof value.version === 'string' &&
    typeof value.description === 'string' && isExtensionType(value.type) && typeof value.verified === 'boolean' &&
    typeof value.license === 'string' && isStringList(value.permissions) && isStringList(value.categories) &&
    isStringList(value.tags) && (value.longDescription === undefined || typeof value.longDescription === 'string') &&
    (value.author === undefined || typeof value.author === 'string' || typeof value.author?.name === 'string') &&
    (value.tarballSha256 === undefined || (typeof value.tarballSha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.tarballSha256))) &&
    value.rating && Number.isSafeInteger(value.rating.count) && value.rating.count >= 0 &&
    Number.isFinite(value.rating.average) && value.rating.average >= 0 && value.rating.average <= 5);
}

function isReview(value: ExtensionReview | null | undefined): value is ExtensionReview {
  return Boolean(value && typeof value.id === 'string' && typeof value.extensionId === 'string' &&
    typeof value.userId === 'string' && Number.isSafeInteger(value.score) && value.score >= 1 && value.score <= 5 &&
    (value.review === undefined || typeof value.review === 'string') && Number.isFinite(Date.parse(value.createdAt)));
}

export function marketplaceError(cause: unknown, fallback: string) {
  if (isAxiosError(cause)) {
    const status = cause.response?.status;
    if (status === 404) return 'La extensión ya no está disponible en el catálogo.';
    if (status === 403) return 'Tu sesión no tiene permiso para realizar esta acción.';
    if (status === 400) return 'Revisa los datos e inténtalo de nuevo.';
    return fallback;
  }
  return cause instanceof Error ? cause.message : fallback;
}

export async function listMarketplace(query: CatalogQuery, signal: AbortSignal): Promise<CatalogResponse> {
  const { data } = await api.get<ApiResponse<MarketplaceListing[]> & { pagination: { total: number } }>(
    endpoint, { params: { ...query, limit: catalogPageSize }, signal },
  );
  if (data?.success !== true || !Array.isArray(data.data) || !data.data.every(isListing) ||
      !Number.isSafeInteger(data.pagination?.total) || data.pagination.total < 0) {
    throw new Error('El servidor devolvió un catálogo incompleto.');
  }
  return { items: data.data, total: data.pagination.total };
}

export async function getMarketplaceListing(id: string, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<MarketplaceListing>>(`${endpoint}/${encodeURIComponent(id)}`, { signal });
  if (data?.success !== true || !isListing(data.data) || (data.data.id !== id && data.data.extensionId !== id)) {
    throw new Error('El servidor devolvió una ficha incompleta.');
  }
  return data.data;
}

export async function getMarketplaceReviews(id: string, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<ExtensionReview[]>>(`${endpoint}/${encodeURIComponent(id)}/ratings`, { signal });
  if (data?.success !== true || !Array.isArray(data.data) || !data.data.every((review) => isReview(review) && review.extensionId === id)) {
    throw new Error('El servidor devolvió reseñas incompletas.');
  }
  return data.data;
}

export async function submitMarketplaceReview(id: string, score: number, review: string) {
  const { data } = await api.post<ApiResponse<{ rating: ExtensionReview; listing: MarketplaceListing }>>(
    `${endpoint}/${encodeURIComponent(id)}/rate`, { score, review },
  );
  const result = data?.data;
  if (data?.success !== true || !result || !isReview(result.rating) || result.rating.extensionId !== id ||
      result.rating.score !== score || !isListing(result.listing) || result.listing.extensionId !== id) {
    throw new Error('El servidor no confirmó la valoración.');
  }
  return result;
}
