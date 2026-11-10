import type { Pool } from 'pg';
import { emitDashboard } from '../../../sockets/socketEmitter';
import { dueReservationPageSize, OrderRepositoryPg, type DueReservation } from '../infra/db/OrderRepositoryPg';

export function startOrderReservationExpiry(db: Pool): () => void {
  const orders = new OrderRepositoryPg(db);
  const afterReservation = new Map<number, DueReservation>();
  let afterCompanyId = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function sweep(): Promise<void> {
    const { rows: companies } = await db.query<{ id: number }>(
      'SELECT id FROM companies WHERE id > $1 ORDER BY id LIMIT 100', [afterCompanyId],
    );
    for (const { id } of companies) {
      if (stopped) return;
      try {
        const due = await orders.listDueReservations(id, afterReservation.get(id));
        if (due.length === dueReservationPageSize) afterReservation.set(id, due[due.length - 1]);
        else afterReservation.delete(id);
        for (const { id: orderId } of due) {
          if (stopped) return;
          try {
            const order = await orders.expireReservation(id, orderId);
            if (order) emitDashboard('order-status-changed', {
              companyId: id, orderId, status: order.status, chatId: order.metadata?.chatId || null,
            });
          } catch (error) {
            console.warn('Order reservation expiry failed', { companyId: id, orderId, code: (error as { code?: string }).code });
          }
        }
      } catch (error) {
        console.warn('Order reservation scan failed', { companyId: id, code: (error as { code?: string }).code });
      }
    }
    afterCompanyId = companies.length === 100 ? companies[99].id : 0;
  }

  async function run(): Promise<void> {
    try {
      await sweep();
    } catch (error) {
      console.warn('Order reservation company scan failed', { code: (error as { code?: string }).code });
    }
    if (!stopped) timer = setTimeout(() => void run(), 10_000).unref();
  }

  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
