/**
 * Canonical error vocabulary for Whatsap-Automat v0.4
 *
 * Mapped to standard RFC 7807 / RFC 9457 ProblemDetails representations.
 */

export const StandardErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  POLICY_DENIED: 'POLICY_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  UNKNOWN_DELIVERY: 'UNKNOWN_DELIVERY',
  RETRYABLE: 'RETRYABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type StandardErrorCode = (typeof StandardErrorCode)[keyof typeof StandardErrorCode];

export const ErrorCodeHttpStatusMap: Record<StandardErrorCode, number> = {
  [StandardErrorCode.UNAUTHORIZED]: 401,
  [StandardErrorCode.POLICY_DENIED]: 403,
  [StandardErrorCode.APPROVAL_REQUIRED]: 428, // Precondition Required (or 403 where policies gate actions)
  [StandardErrorCode.NOT_FOUND]: 404,
  [StandardErrorCode.CONFLICT]: 409,
  [StandardErrorCode.VALIDATION_ERROR]: 422,
  [StandardErrorCode.RATE_LIMITED]: 429,
  [StandardErrorCode.UNKNOWN_DELIVERY]: 502,
  [StandardErrorCode.RETRYABLE]: 503,
  [StandardErrorCode.INTERNAL_ERROR]: 500,
};
