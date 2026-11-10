import type { MobileApproval } from './apiClient';

interface AlertCursor {
  newest: number;
  idsAtNewest: ReadonlySet<string>;
}

export function observeApprovalAlerts(
  previous: AlertCursor | undefined,
  page: readonly MobileApproval[],
  now = Date.now(),
) {
  const pending = page.flatMap(({ id, createdAt, expiresAt, status }) => {
    const created = Date.parse(createdAt);
    return status === 'pending' && Number.isFinite(created) && Date.parse(expiresAt) > now
      ? [{ id, created }]
      : [];
  });
  const newest = Math.max(previous?.newest ?? -Infinity, ...pending.map(({ created }) => created));
  const idsAtNewest = new Set(newest === previous?.newest ? previous.idsAtNewest : undefined);
  for (const { id, created } of pending) {
    if (created === newest) idsAtNewest.add(id);
  }
  const newIds = previous ? pending.filter(({ id, created }) =>
    created > previous.newest || (created === previous.newest && !previous.idsAtNewest.has(id)),
  ).map(({ id }) => id) : [];
  return { cursor: { newest, idsAtNewest }, newIds, pendingIds: new Set(pending.map(({ id }) => id)) };
}
