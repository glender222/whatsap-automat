import { Router } from 'express';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import { workflowController, WorkflowController } from '../controllers/WorkflowController';

export default function createWorkflowRoutes(
  controller: WorkflowController = workflowController
): Router {
  const router = Router();

  // 1. Channel-less Inbound Webhook (UC-06) — Public / Token-gated
  router.post('/triggers/webhook/:endpointKey', controller.handleWebhookTrigger);

  // 2. Atomic Rollback Engine — Authenticated via JWT & Tenant Context
  router.post('/:id/rollback', requireJwt, tenantContext(), controller.rollbackWorkflow);

  return router;
}
