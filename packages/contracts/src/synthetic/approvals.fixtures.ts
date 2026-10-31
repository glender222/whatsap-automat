import { ApprovalDecisionCommandV1, ApprovalRequestV1 } from '../approvals/types';

const mockDate = '2026-10-31T02:00:00.000Z';
const mockExpiryDate = '2026-10-31T04:00:00.000Z';
const mockTenantId = 'tenant_synthetic_alpha';

export const pendingApprovalFixture: ApprovalRequestV1 = {
  id: 'appr_req_discount_001',
  tenantId: mockTenantId,
  runId: 'run_commercial_001',
  nodeId: 'node_approval_discount',
  effectKey: 'eff_discount_order_1042_pct20',
  proposedActionHash: 'sha256_discount_action_hash_987654',
  policyVersion: 1,
  risk: 'medium',
  status: 'pending',
  expiresAt: mockExpiryDate,
  details: {
    toolName: 'sales.apply_special_discount',
    summary: 'Aplicar descuento de 20% a orden #1042 (excede límite automático de 15%)',
    parametersRedacted: {
      orderId: '1042',
      discountPercentage: 20,
      clientTier: 'GOLD',
    },
    requiredRole: 'SALES_SUPERVISOR',
  },
  createdAt: mockDate,
};

export const approvedDecisionCommandFixture: ApprovalDecisionCommandV1 = {
  schemaVersion: 1,
  decision: 'approved',
  reason: 'Cliente VIP verificado, margen comercial aceptable.',
  expectedVersion: 1,
  actor: {
    tenantId: mockTenantId,
    userId: 'user_supervisor_42',
    roles: ['SALES_SUPERVISOR', 'AGENT'],
    requestId: 'req_decision_appr_001',
  },
};

export const rejectedDecisionCommandFixture: ApprovalDecisionCommandV1 = {
  schemaVersion: 1,
  decision: 'rejected',
  reason: 'Margen insuficiente para el producto seleccionado.',
  expectedVersion: 1,
  actor: {
    tenantId: mockTenantId,
    userId: 'user_supervisor_42',
    roles: ['SALES_SUPERVISOR', 'AGENT'],
    requestId: 'req_decision_appr_002',
  },
};

export const expiredApprovalFixture: ApprovalRequestV1 = {
  id: 'appr_req_expired_001',
  tenantId: mockTenantId,
  runId: 'run_commercial_002',
  nodeId: 'node_approval_refund',
  effectKey: 'eff_refund_order_999',
  proposedActionHash: 'sha256_refund_action_hash_112233',
  policyVersion: 1,
  risk: 'high',
  status: 'expired',
  expiresAt: '2026-10-30T12:00:00.000Z',
  createdAt: '2026-10-30T10:00:00.000Z',
};
