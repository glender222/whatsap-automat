import { isAxiosError } from 'axios';
import { api } from '../../shared/axios/http';

export type CampaignChannel = 'whatsapp-cloud' | 'email' | 'telegram' | 'webchat';
export type CampaignPurpose = 'marketing' | 'broadcast' | 'transactional' | 'support';

export interface CampaignDraft {
  name: string;
  channel: CampaignChannel;
  purpose: CampaignPurpose;
  segmentId?: string;
  contentBody?: string;
  contentSubject?: string;
  templateId?: string;
  templateVariables?: { languageCode: string };
  rateLimitPerMinute: number;
  failurePauseThresholdPercent: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  channel: string;
  status: string;
  segmentId?: string | null;
  statsDispatched?: number;
  statsFailed?: number;
  statsSuppressed?: number;
  pauseReason?: string | null;
}

export interface DispatchReview {
  campaignId: string;
  campaignStatus: string;
  segmentName: string | null;
  audienceCount: number;
  unattemptedCount: number;
  audienceLimit: number;
  limitExceeded: boolean;
  reviewKey: string;
  contentBody?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
}

export function isDispatchableStatus(status: string) {
  return status === 'draft' || status === 'queued' || status === 'paused';
}

interface SegmentRule {
  field: string;
  operator: string;
  value: string | string[] | number;
}

export interface SegmentDraft {
  name: string;
  description?: string;
  targetChannel: CampaignChannel | 'any';
  criteria: { combinator: 'AND' | 'OR'; rules: SegmentRule[] };
}

export interface SegmentSummary extends Omit<SegmentDraft, 'targetChannel' | 'description'> {
  id: string;
  description?: string | null;
  targetChannel: string;
  calculatedCount: number;
  lastCalculatedAt?: string | null;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

function result<T>(response: ApiResponse<T>): T {
  if (response.success !== true || response.data == null) {
    throw new Error(response.message || 'El servidor devolvió una respuesta incompleta.');
  }
  return response.data;
}

export function campaignError(error: unknown, fallback: string) {
  if (isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (typeof message === 'string' && message.length > 0 && message.length < 200) return message;
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export const channelLabels: Record<CampaignChannel, string> = {
  'whatsapp-cloud': 'WhatsApp',
  email: 'Correo electrónico',
  telegram: 'Telegram',
  webchat: 'Webchat',
};

export function channelLabel(channel: string) {
  return channelLabels[channel as CampaignChannel] ?? channel;
}

export async function listCampaigns(signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<CampaignSummary[]>>('/v1/campaigns', { signal });
  const campaigns = result(data);
  if (!Array.isArray(campaigns)) throw new Error('El listado de campañas no es válido.');
  return campaigns;
}

export async function createCampaignDraft(draft: CampaignDraft) {
  const { data } = await api.post<ApiResponse<CampaignSummary>>('/v1/campaigns', draft);
  const campaign = result(data);
  if (!campaign.id || campaign.status !== 'draft') throw new Error('El servidor no confirmó el borrador.');
  return campaign;
}

export async function reviewCampaignDispatch(campaignId: string, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<DispatchReview>>(
    `/v1/campaigns/${encodeURIComponent(campaignId)}/dispatch-review`, { signal },
  );
  const review = result(data);
  if (review.campaignId !== campaignId || typeof review.campaignStatus !== 'string' ||
      (review.segmentName !== null && typeof review.segmentName !== 'string') ||
      !Number.isSafeInteger(review.audienceCount) || review.audienceCount < 0 ||
      !Number.isSafeInteger(review.unattemptedCount) || review.unattemptedCount < 0 ||
      review.unattemptedCount > review.audienceCount ||
      !Number.isSafeInteger(review.audienceLimit) || review.audienceLimit < 1 ||
      review.limitExceeded !== (review.audienceCount > review.audienceLimit) ||
      typeof review.reviewKey !== 'string' || !/^[a-f0-9]{64}$/.test(review.reviewKey)) {
    throw new Error('El servidor no confirmó la revisión de la campaña.');
  }
  return review;
}

export async function dispatchCampaign(campaignId: string, reviewKey: string) {
  const { data } = await api.post<ApiResponse<CampaignSummary>>(
    `/v1/campaigns/${encodeURIComponent(campaignId)}/dispatch`, { reviewKey },
  );
  const campaign = result(data);
  if (campaign.id !== campaignId || !['queued', 'dispatching', 'paused', 'completed', 'failed'].includes(campaign.status)) {
    throw new Error('El servidor no confirmó el estado del despacho.');
  }
  return campaign;
}

export async function listSegments(signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<SegmentSummary[]>>('/v1/segments', { signal });
  const segments = result(data);
  if (!Array.isArray(segments)) throw new Error('El listado de segmentos no es válido.');
  return segments;
}

export async function createSegment(draft: SegmentDraft) {
  const { data } = await api.post<ApiResponse<SegmentSummary>>('/v1/segments', draft);
  const segment = result(data);
  if (!segment.id) throw new Error('El servidor no confirmó el segmento.');
  return segment;
}

export async function calculateSegment(segmentId: string) {
  const { data } = await api.post<ApiResponse<{ segmentId: string; count: number }>>(
    `/v1/segments/${encodeURIComponent(segmentId)}/calculate`,
  );
  const calculation = result(data);
  if (calculation.segmentId !== segmentId || !Number.isSafeInteger(calculation.count) || calculation.count < 0) {
    throw new Error('El servidor no confirmó el recuento.');
  }
  return calculation.count;
}
