import { withTenantTransaction } from '../../db/TenantScopedUoW';

const operatorCapabilities = ['conversations.read', 'conversations.operate', 'campaigns.read'];
const adminCapabilities = ['campaigns.dispatch', 'audit.read', 'diagnostics.read', 'approvals.review'];

export function getCurrentWorkspace(tenantId: number, userId: number, sessionRole: string | undefined) {
  return withTenantTransaction(tenantId, async (client) => {
    const { rows: [workspace] } = await client.query(
      `SELECT t.name AS tenant_name, w.id, w.name, w.slug, m.role, u.rol AS user_role
       FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id AND m.user_id = $2
       JOIN usuarios u ON u.id = m.user_id AND u.company_id = t.id AND u.activo
       JOIN workspaces w ON w.tenant_id = t.id AND w.is_default
       WHERE t.id = $1 AND t.status = 'active'
       ORDER BY w.id LIMIT 1`,
      [tenantId, userId]
    );
    if (!workspace) return null;

    const isAdmin = (workspace.role === 'owner' || workspace.role === 'admin') &&
      workspace.user_role === 'ADMIN' && sessionRole === 'ADMIN';
    return {
      tenantId: String(tenantId),
      tenantName: workspace.tenant_name,
      workspaceId: String(workspace.id),
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
      roles: [workspace.role],
      capabilities: isAdmin ? [...operatorCapabilities, ...adminCapabilities] : operatorCapabilities,
    };
  });
}
