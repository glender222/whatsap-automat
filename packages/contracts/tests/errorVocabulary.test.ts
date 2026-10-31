import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StandardErrorCode,
  ErrorCodeHttpStatusMap,
  createProblemDetails,
  isProblemDetails,
  problemDetailsV1Schema,
  problemDetailsFixtures,
} from '../src';

describe('Error Vocabulary & RFC 7807/9457 ProblemDetails Contracts', () => {
  it('covers all standard error codes with valid HTTP status codes', () => {
    for (const code of Object.values(StandardErrorCode)) {
      const status = ErrorCodeHttpStatusMap[code];
      assert.ok(typeof status === 'number');
      assert.ok(status >= 400 && status < 600, `Status for ${code} must be 4xx or 5xx`);
    }
  });

  it('validates all synthetic problemDetails fixtures against problemDetailsV1Schema', () => {
    for (const [code, fixture] of Object.entries(problemDetailsFixtures)) {
      const parsed = problemDetailsV1Schema.safeParse(fixture);
      assert.ok(parsed.success, `ProblemDetails validation failed for ${code}: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.code, code);
      assert.equal(isProblemDetails(fixture), true);
    }
  });

  it('creates RFC 7807 compliant problem details with custom properties', () => {
    const error = createProblemDetails({
      code: StandardErrorCode.CONFLICT,
      detail: 'State version mismatch',
      instance: '/api/v1/conversations/conv_1/takeover',
      correlationId: 'corr_test_123',
      metadata: { currentVersion: 5, expectedVersion: 4 },
    });

    assert.equal(error.status, 409);
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.correlationId, 'corr_test_123');
    assert.equal(error.metadata?.['currentVersion'], 5);

    const parsed = problemDetailsV1Schema.safeParse(error);
    assert.ok(parsed.success);
  });

  it('rejects invalid problem details object with missing correlationId or invalid status', () => {
    const invalidStatus = {
      type: 'https://example.com/err',
      title: 'Err',
      status: 200, // Invalid: must be 4xx or 5xx
      detail: 'Not an error',
      instance: '/test',
      code: StandardErrorCode.VALIDATION_ERROR,
      correlationId: 'corr_1',
    };
    assert.equal(problemDetailsV1Schema.safeParse(invalidStatus).success, false);

    const missingCorr = {
      type: 'https://example.com/err',
      title: 'Err',
      status: 400,
      detail: 'Err',
      instance: '/test',
      code: StandardErrorCode.VALIDATION_ERROR,
    };
    assert.equal(problemDetailsV1Schema.safeParse(missingCorr).success, false);
  });
});
