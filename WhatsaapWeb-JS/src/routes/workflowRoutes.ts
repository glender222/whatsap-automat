import { Router } from 'express';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import { workflowController, WorkflowController } from '../controllers/WorkflowController';

export default function createWorkflowRoutes(
  controller: WorkflowController = workflowController
): Router {
  const router = Router();
  const authenticatedTenant = [requireJwt, tenantContext({ allowSandbox: false })];

  router.post('/triggers/webhook/:endpointKey', controller.handleWebhookTrigger);
  router.get('/runs/:runId', ...authenticatedTenant, controller.getRun);
  router.post('/', ...authenticatedTenant, controller.createWorkflow);
  router.post('/:id/revisions', ...authenticatedTenant, controller.createRevision);
  router.post('/:id/publish', ...authenticatedTenant, controller.publishWorkflow);
  router.post('/:id/triggers/webhook', ...authenticatedTenant, controller.createWebhookTrigger);
  router.patch('/:id/triggers/:triggerId', ...authenticatedTenant, controller.setWebhookTriggerActive);
  router.post('/:id/rollback', ...authenticatedTenant, controller.rollbackWorkflow);

  return router;
}
