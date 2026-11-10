import { approvalPageSize, approvalsPath, riskLabels, type Risk } from './approvalApi';

export type ApprovalQueueQuery = { risk: Risk | ''; page: number };

export function readApprovalQueue(params: URLSearchParams): ApprovalQueueQuery {
  const risk = params.get('riesgo') ?? '';
  const rawPage = params.get('pagina') ?? '1';
  const page = Number(rawPage);
  return {
    risk: Object.hasOwn(riskLabels, risk) ? risk as Risk : '',
    page: /^\d+$/.test(rawPage) && Number.isSafeInteger(page) && page > 0
      ? Math.min(page, Math.floor(10000 / approvalPageSize) + 1) : 1,
  };
}

export function approvalQueueParams(query: ApprovalQueueQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.risk) params.set('riesgo', query.risk);
  if (query.page > 1) params.set('pagina', String(query.page));
  return params;
}

export function approvalLocation(query: ApprovalQueueQuery, id?: string): string {
  const path = id ? `${approvalsPath}/${encodeURIComponent(id)}` : approvalsPath;
  const params = approvalQueueParams(query);
  return params.size ? `${path}?${params}` : path;
}
