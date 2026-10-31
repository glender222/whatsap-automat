import { ErrorCodeHttpStatusMap, StandardErrorCode } from './codes';

export interface InvalidParamDetail {
  readonly name: string;
  readonly reason: string;
}

/**
 * Standard RFC 7807 / RFC 9457 Problem Details object
 */
export interface ProblemDetailsV1 {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: StandardErrorCode;
  readonly correlationId: string;
  readonly invalidParams?: readonly InvalidParamDetail[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateProblemDetailsOptions {
  readonly code: StandardErrorCode;
  readonly detail: string;
  readonly instance: string;
  readonly correlationId: string;
  readonly title?: string;
  readonly typeUri?: string;
  readonly invalidParams?: readonly InvalidParamDetail[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createProblemDetails(options: CreateProblemDetailsOptions): ProblemDetailsV1 {
  const status = ErrorCodeHttpStatusMap[options.code] ?? 500;
  const defaultTitles: Record<StandardErrorCode, string> = {
    [StandardErrorCode.UNAUTHORIZED]: 'Authentication required',
    [StandardErrorCode.POLICY_DENIED]: 'Action denied by security or tenant policy',
    [StandardErrorCode.APPROVAL_REQUIRED]: 'Human approval required before execution',
    [StandardErrorCode.NOT_FOUND]: 'Resource not found',
    [StandardErrorCode.CONFLICT]: 'Resource conflict or stale version',
    [StandardErrorCode.VALIDATION_ERROR]: 'Validation error in request payload',
    [StandardErrorCode.RATE_LIMITED]: 'Rate limit exceeded',
    [StandardErrorCode.UNKNOWN_DELIVERY]: 'Unknown delivery status from provider',
    [StandardErrorCode.RETRYABLE]: 'Transient error, please retry with backoff',
    [StandardErrorCode.INTERNAL_ERROR]: 'An internal error occurred',
  };

  const title = options.title ?? defaultTitles[options.code] ?? 'Internal error';
  const typeUri = options.typeUri ?? `https://api.whatsap-automat.internal/errors/${options.code.toLowerCase().replace(/_/g, '-')}`;

  return {
    type: typeUri,
    title,
    status,
    detail: options.detail,
    instance: options.instance,
    code: options.code,
    correlationId: options.correlationId,
    ...(options.invalidParams && options.invalidParams.length > 0 ? { invalidParams: options.invalidParams } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function isProblemDetails(value: unknown): value is ProblemDetailsV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['type'] === 'string' &&
    typeof candidate['title'] === 'string' &&
    typeof candidate['status'] === 'number' &&
    typeof candidate['detail'] === 'string' &&
    typeof candidate['instance'] === 'string' &&
    typeof candidate['code'] === 'string' &&
    typeof candidate['correlationId'] === 'string'
  );
}
