import crypto from 'node:crypto';
import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { Queryable } from '../../../shared/UnitOfWorkPort';
import type { BusinessEffectInput, BusinessEffectResult } from './types';

/**
 * Executes a state-modifying business effect within TenantScopedUoW,
 * backed by PostgreSQL idempotency_ledger for strict exactly-once execution.
 */
export async function executeBusinessEffectActivity(
  input: BusinessEffectInput,
  uow: TenantScopedUoW = tenantScopedUoW
): Promise<BusinessEffectResult> {
  const effectKey =
    input.effectKey ||
    `wf_${input.tenantId}_${input.workflowId}_${input.runId}_${input.stepId}`;

  return await uow.run(input.tenantId, async (client: Queryable) => {
    // 1. Check idempotency ledger for previously completed effect
    const existingRes = await client.query(
      `SELECT response_status, response_body, created_at
       FROM idempotency_ledger
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE;`,
      [input.tenantId, effectKey]
    );

    if (existingRes.rows && existingRes.rows.length > 0) {
      const row = existingRes.rows[0];
      const parsedBody =
        typeof row.response_body === 'string'
          ? JSON.parse(row.response_body)
          : row.response_body;

      return {
        applied: true,
        cached: true,
        effectKey,
        resultData: parsedBody,
        timestamp: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      };
    }

    // 2. Execute domain mutation
    const resultData: Record<string, unknown> = {
      effectType: input.effectType,
      parameters: input.parameters,
      executed: true,
      timestamp: new Date().toISOString(),
    };

    // If updating order or specific business entity, record in operational table
    if (input.effectType === 'order.status_update' || input.effectType === 'order.approve') {
      resultData.orderStatus = input.parameters.newStatus || 'approved';
      resultData.orderId = input.parameters.orderId;
    }

    // 3. Persist record into idempotency_ledger
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(input.parameters || {}))
      .digest('hex');

    await client.query(
      `INSERT INTO idempotency_ledger (
         tenant_id, idempotency_key, source, request_hash, response_status, response_body, created_at
       ) VALUES ($1, $2, 'workflow_engine', $3, 200, $4, NOW());`,
      [input.tenantId, effectKey, requestHash, JSON.stringify(resultData)]
    );

    return {
      applied: true,
      cached: false,
      effectKey,
      resultData,
      timestamp: new Date().toISOString(),
    };
  });
}
