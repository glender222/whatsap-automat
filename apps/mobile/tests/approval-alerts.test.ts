import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MobileApproval } from '../src/services/apiClient';
import { observeApprovalAlerts } from '../src/services/approvalAlerts';

const now = Date.parse('2026-11-10T10:00:00Z');
function approval(id: string, age: number, overrides: Partial<MobileApproval> = {}): MobileApproval {
  return {
    id, createdAt: new Date(now - age).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    policyVersion: 1, status: 'pending', risk: 'write', ...overrides,
  };
}

test('seeds the current page without announcing history and ignores older rows appearing after removals', () => {
  const initial = observeApprovalAlerts(undefined, [approval('known', 20), approval('old', 30)], now);
  assert.deepEqual(initial.newIds, []);
  const first = observeApprovalAlerts(initial.cursor, [approval('new', 10), approval('old', 30)], now);
  assert.deepEqual(first.newIds, ['new']);
  const later = observeApprovalAlerts(first.cursor, [approval('new', 10), approval('older', 40)], now);
  assert.deepEqual(later.newIds, []);
  assert.deepEqual([...later.pendingIds], ['new', 'older']);
});

test('deduplicates the same approval across policy revisions and handles distinct approvals created in the same instant', () => {
  const first = observeApprovalAlerts(undefined, [approval('a', 30)], now);
  const tied = observeApprovalAlerts(first.cursor, [approval('a', 30, { policyVersion: 2 }), approval('b', 30)], now);
  assert.deepEqual(tied.newIds, ['b']);
  const absent = observeApprovalAlerts(tied.cursor, [], now);
  assert.deepEqual(observeApprovalAlerts(absent.cursor, [approval('b', 30)], now).newIds, []);
});

test('after an empty baseline only active, valid approvals can create alerts', () => {
  const empty = observeApprovalAlerts(undefined, [], now);
  const result = observeApprovalAlerts(empty.cursor, [
    approval('valid', 10),
    approval('decided', 10, { status: 'approved' }),
    approval('expired', 10, { expiresAt: new Date(now).toISOString() }),
    approval('invalid', 10, { createdAt: 'invalid' }),
  ], now);
  assert.deepEqual(result.newIds, ['valid']);
  assert.deepEqual([...result.pendingIds], ['valid']);
});
