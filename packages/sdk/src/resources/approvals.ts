import { ApprovalRequestV1, ApprovalDecisionCommandV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';

export class ApprovalsResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: { status?: string; limit?: number } = {}): Promise<ApprovalRequestV1[]> {
    const res = await this.http.get<{ items: ApprovalRequestV1[] }>('/approvals', {
      query: params,
    });
    return res.items ?? (res as unknown as ApprovalRequestV1[]);
  }

  async get(id: string): Promise<ApprovalRequestV1> {
    return this.http.get<ApprovalRequestV1>(`/approvals/${id}`);
  }

  async decide(id: string, command: Omit<ApprovalDecisionCommandV1, 'approvalId'>): Promise<ApprovalRequestV1> {
    return this.http.post<ApprovalRequestV1>(`/approvals/${id}/decision`, command);
  }
}
