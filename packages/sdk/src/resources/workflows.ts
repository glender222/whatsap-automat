import { WorkflowRevisionV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';

export class WorkflowsResource {
  constructor(private readonly http: HttpClient) {}

  async publish(id: string): Promise<WorkflowRevisionV1> {
    return this.http.post<WorkflowRevisionV1>(`/automation-definitions/${id}/publish`);
  }

  async rollback(id: string, targetRevisionNumber: number): Promise<WorkflowRevisionV1> {
    return this.http.post<WorkflowRevisionV1>(`/workflows/${id}/rollback`, {
      targetRevisionNumber,
    });
  }
}
