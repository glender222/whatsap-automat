import { HttpClient } from '../http';

export interface WorkflowPublishResult {
  workflowId: string;
  publishedRevisionId: string;
  status: 'published';
}

export interface WorkflowRollbackResult {
  success: true;
  workflowId: string;
  previousRevisionId: string | null;
  publishedRevisionId: string;
  targetRevisionNumber: number;
  latencyMs: number;
  updatedAt: string;
}

export class WorkflowsResource {
  constructor(private readonly http: HttpClient) {}

  async publish(id: string, revisionId: string): Promise<WorkflowPublishResult> {
    const { data } = await this.http.post<{ data: WorkflowPublishResult }>(`/workflows/${id}/publish`, { revisionId });
    return data;
  }

  async rollback(id: string, targetRevisionNumber: number, reason: string): Promise<WorkflowRollbackResult> {
    return this.http.post<WorkflowRollbackResult>(`/workflows/${id}/rollback`, { targetRevisionNumber, reason });
  }
}
