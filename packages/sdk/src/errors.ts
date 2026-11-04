import { ProblemDetailsV1, StandardErrorCode } from '@whatsap-automat/contracts';

export class ProblemDetailsError extends Error {
  readonly type: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly code?: StandardErrorCode | string;
  readonly correlationId?: string;
  readonly invalidParams?: ReadonlyArray<{ name: string; reason: string }>;
  readonly metadata?: Readonly<Record<string, unknown>>;

  constructor(problem: Partial<ProblemDetailsV1> & { message?: string; status?: number }) {
    super(problem.detail || problem.message || problem.title || `HTTP error ${problem.status ?? 500}`);
    this.name = 'ProblemDetailsError';
    this.type = problem.type || 'about:blank';
    this.status = problem.status ?? 500;
    this.detail = problem.detail || this.message;
    this.instance = problem.instance;
    this.code = problem.code;
    this.correlationId = problem.correlationId;
    this.invalidParams = problem.invalidParams;
    this.metadata = problem.metadata;
  }
}

export class UnauthorizedError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 401, title: problem.title || 'Unauthorized' });
    this.name = 'UnauthorizedError';
  }
}

export class PolicyDeniedError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 403, title: problem.title || 'Policy Denied' });
    this.name = 'PolicyDeniedError';
  }
}

export class NotFoundError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 404, title: problem.title || 'Not Found' });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 409, title: problem.title || 'Conflict' });
    this.name = 'ConflictError';
  }
}

export class ValidationError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 422, title: problem.title || 'Validation Error' });
    this.name = 'ValidationError';
  }
}

export class ApprovalRequiredError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 428, title: problem.title || 'Approval Required' });
    this.name = 'ApprovalRequiredError';
  }
}

export class RateLimitedError extends ProblemDetailsError {
  readonly retryAfterSeconds?: number;

  constructor(problem: Partial<ProblemDetailsV1> = {}, retryAfterSeconds?: number) {
    super({ ...problem, status: 429, title: problem.title || 'Rate Limited' });
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UnknownDeliveryError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 502, title: problem.title || 'Unknown Delivery Status' });
    this.name = 'UnknownDeliveryError';
  }
}

export class ServiceUnavailableError extends ProblemDetailsError {
  constructor(problem: Partial<ProblemDetailsV1> = {}) {
    super({ ...problem, status: 503, title: problem.title || 'Service Unavailable' });
    this.name = 'ServiceUnavailableError';
  }
}

export function createErrorFromResponse(
  status: number,
  body: unknown,
  headers?: Headers
): ProblemDetailsError {
  const prob = (typeof body === 'object' && body !== null ? body : {}) as Partial<ProblemDetailsV1>;
  const retryAfterHeader = headers?.get('retry-after');
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

  switch (status) {
    case 401:
      return new UnauthorizedError(prob);
    case 403:
      return new PolicyDeniedError(prob);
    case 404:
      return new NotFoundError(prob);
    case 409:
      return new ConflictError(prob);
    case 422:
      return new ValidationError(prob);
    case 428:
      return new ApprovalRequiredError(prob);
    case 429:
      return new RateLimitedError(prob, retryAfter);
    case 502:
      return new UnknownDeliveryError(prob);
    case 503:
      return new ServiceUnavailableError(prob);
    default:
      return new ProblemDetailsError({ ...prob, status });
  }
}
