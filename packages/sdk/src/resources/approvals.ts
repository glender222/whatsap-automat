import { ApprovalRequestV1, ApprovalDecisionCommandV1, ApprovalDecisionResultV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';
import { PolicyDeniedError, ValidationError } from '../errors';

export class ApprovalsResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: { status?: string; risk?: string; limit?: number; offset?: number } = {}): Promise<ApprovalRequestV1[]> {
    const res = await this.http.get<{ items: ApprovalRequestV1[] }>('/approvals', {
      query: params,
    });
    return res.items ?? (res as unknown as ApprovalRequestV1[]);
  }

  async get(id: string): Promise<ApprovalRequestV1> {
    return this.http.get<ApprovalRequestV1>(`/approvals/${id}`);
  }

  /** Supply the current password only for explicit reauthentication over HTTPS or loopback. */
  async decide(
    id: string,
    command: Omit<ApprovalDecisionCommandV1, 'approvalId' | 'schemaVersion'> & { schemaVersion?: 1; password?: string },
    idempotencyKey: string = globalThis.crypto.randomUUID(),
  ): Promise<ApprovalDecisionResultV1> {
    const { password, ...decision } = command;
    const sensitive = password !== undefined;
    if (sensitive && (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || id === '.' || id === '..')) {
      throw new ValidationError({ detail: 'Invalid approval identifier.' });
    }
    if (sensitive) {
      const workspace = await this.http.get<{ capabilities?: unknown } | null>('/workspaces/current', { sensitive });
      const capabilities = workspace?.capabilities;
      if (!Array.isArray(capabilities) || !capabilities.includes('approvals.review') || !capabilities.includes('approvals.reauthenticate')) {
        throw new PolicyDeniedError({ code: 'POLICY_DENIED', detail: 'This workspace does not support approval reauthentication.' });
      }
    }
    return this.http.post<ApprovalDecisionResultV1>(`/approvals/${sensitive ? encodeURIComponent(id) : id}/decision`, {
      ...decision, ...(sensitive ? { password } : {}),
    }, {
      headers: { 'Idempotency-Key': idempotencyKey },
      sensitive,
    });
  }
}
