import { ApprovalRequestV1, ApprovalDecisionCommandV1, ApprovalDecisionResultV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';

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

  async decide(
    id: string,
    command: Omit<ApprovalDecisionCommandV1, 'approvalId' | 'schemaVersion'> & { schemaVersion?: 1 },
    idempotencyKey: string = globalThis.crypto.randomUUID(),
  ): Promise<ApprovalDecisionResultV1> {
    return this.http.post<ApprovalDecisionResultV1>(`/approvals/${id}/decision`, command, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }
}
