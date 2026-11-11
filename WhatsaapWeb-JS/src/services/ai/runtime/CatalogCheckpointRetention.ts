import type { Queryable } from '../../../shared/UnitOfWorkPort';
import type { CatalogRouterCheckpointStore } from './CatalogRouterCheckpointStore';

const companyPageSize = 100;
const concurrentCompanies = 4;

/** One bounded page per tick; retention never depends on Studio traffic or provider access. */
export function startCatalogCheckpointRetention(
  database: Queryable,
  checkpoints: Pick<CatalogRouterCheckpointStore, 'eraseExpired'>,
  intervalMs = 10_000,
): () => Promise<void> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new RangeError('Invalid catalog retention interval');
  }
  let afterCompanyId = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void>;

  async function sweep(): Promise<void> {
    const { rows } = await database.query(
      'SELECT id FROM companies WHERE id > $1 ORDER BY id LIMIT 100', [afterCompanyId],
    );
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrentCompanies, rows.length) }, async () => {
      while (!stopped && next < rows.length) {
        const { id } = rows[next++];
        try {
          // The store bounds each tenant to 100 runs, SKIP LOCKED and a one-second statement timeout.
          await checkpoints.eraseExpired(id);
        } catch (error) {
          console.warn('Catalog checkpoint retention failed', { companyId: id, code: errorCode(error) });
        }
      }
    }));
    afterCompanyId = rows.length === companyPageSize ? rows[rows.length - 1].id : 0;
  }

  async function run(): Promise<void> {
    try {
      await sweep();
    } catch (error) {
      console.warn('Catalog checkpoint company scan failed', { code: errorCode(error) });
    }
    if (!stopped) timer = setTimeout(() => { running = run(); }, intervalMs).unref();
  }

  running = run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'RETENTION_FAILED';
}
