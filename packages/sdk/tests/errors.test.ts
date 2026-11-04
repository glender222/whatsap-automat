import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createErrorFromResponse,
  ProblemDetailsError,
  UnauthorizedError,
  PolicyDeniedError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ApprovalRequiredError,
  RateLimitedError,
  UnknownDeliveryError,
  ServiceUnavailableError,
} from '../src/errors';

describe('@whatsap-automat/sdk: Error Handling & RFC 7807 Mapping', () => {
  it('maps HTTP 401 to UnauthorizedError', () => {
    const err = createErrorFromResponse(401, {
      title: 'Unauthorized',
      detail: 'Invalid API Key',
    });
    assert.ok(err instanceof UnauthorizedError);
    assert.equal(err.status, 401);
    assert.equal(err.detail, 'Invalid API Key');
  });

  it('maps HTTP 403 to PolicyDeniedError', () => {
    const err = createErrorFromResponse(403, {
      title: 'Policy Denied',
      detail: 'Scope messages:send denied by workspace policy',
    });
    assert.ok(err instanceof PolicyDeniedError);
    assert.equal(err.status, 403);
  });

  it('maps HTTP 404 to NotFoundError', () => {
    const err = createErrorFromResponse(404, {
      title: 'Not Found',
      detail: 'Conversation not found',
    });
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.status, 404);
  });

  it('maps HTTP 409 to ConflictError', () => {
    const err = createErrorFromResponse(409, {
      title: 'Conflict',
      detail: 'CAS version conflict: expected 2 but current is 3',
    });
    assert.ok(err instanceof ConflictError);
    assert.equal(err.status, 409);
  });

  it('maps HTTP 422 to ValidationError', () => {
    const err = createErrorFromResponse(422, {
      title: 'Validation Error',
      detail: 'Invalid phone number format',
      invalidParams: [{ name: 'phoneNumber', reason: 'Must be E.164' }],
    });
    assert.ok(err instanceof ValidationError);
    assert.equal(err.status, 422);
    assert.equal(err.invalidParams?.length, 1);
  });

  it('maps HTTP 428 to ApprovalRequiredError', () => {
    const err = createErrorFromResponse(428, {
      title: 'Approval Required',
      detail: 'Action requires human approval',
    });
    assert.ok(err instanceof ApprovalRequiredError);
    assert.equal(err.status, 428);
  });

  it('maps HTTP 429 to RateLimitedError and extracts retry-after header', () => {
    const headers = new Headers({ 'retry-after': '60' });
    const err = createErrorFromResponse(429, {
      title: 'Rate Limit Exceeded',
      detail: 'Too many requests',
    }, headers);
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.status, 429);
    assert.equal((err as RateLimitedError).retryAfterSeconds, 60);
  });

  it('maps HTTP 502 to UnknownDeliveryError', () => {
    const err = createErrorFromResponse(502, {
      title: 'Bad Gateway',
      detail: 'Upstream gateway failure',
    });
    assert.ok(err instanceof UnknownDeliveryError);
    assert.equal(err.status, 502);
  });

  it('maps HTTP 503 to ServiceUnavailableError', () => {
    const err = createErrorFromResponse(503, {
      title: 'Service Unavailable',
      detail: 'Down for maintenance',
    });
    assert.ok(err instanceof ServiceUnavailableError);
    assert.equal(err.status, 503);
  });

  it('falls back to generic ProblemDetailsError for unrecognized status codes', () => {
    const err = createErrorFromResponse(418, {
      title: "I'm a teapot",
      detail: 'Refusing to brew coffee',
    });
    assert.ok(err instanceof ProblemDetailsError);
    assert.equal(err.status, 418);
    assert.equal(err.detail, 'Refusing to brew coffee');
  });
});
