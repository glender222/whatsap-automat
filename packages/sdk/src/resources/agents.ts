import {
  AgentGraphVersionV1,
  AgentRunTraceV1,
  AgentSimulationRequestV1,
  AgentSimulationResultV1,
  SimulatedNodeExecutionV1,
} from '@whatsap-automat/contracts';
import { HttpClient } from '../http';

export class AgentsResource {
  constructor(private readonly http: HttpClient) {}

  async listGraphs(): Promise<AgentGraphVersionV1[]> {
    const res = await this.http.get<{ items: AgentGraphVersionV1[] }>('/agent-graphs');
    return res.items ?? (res as unknown as AgentGraphVersionV1[]);
  }

  async getGraph(id: string): Promise<AgentGraphVersionV1> {
    return this.http.get<AgentGraphVersionV1>(`/agent-graphs/${id}`);
  }

  async validateGraph(id: string): Promise<{ valid: boolean; errors?: string[] }> {
    return this.http.post<{ valid: boolean; errors?: string[] }>(`/agent-graphs/${id}/validate`);
  }

  async publishGraph(id: string): Promise<AgentGraphVersionV1> {
    return this.http.post<AgentGraphVersionV1>(`/agent-graphs/${id}/publish`);
  }

  async simulate(request: AgentSimulationRequestV1): Promise<SimulatedNodeExecutionV1[]> {
    const result = await this.http.post<AgentSimulationResultV1 | SimulatedNodeExecutionV1[]>('/agent-runs/simulate', request);
    return Array.isArray(result) ? result : [...result.executedNodes];
  }

  async getTrace(runId: string): Promise<AgentRunTraceV1> {
    return this.http.get<AgentRunTraceV1>(`/agent-runs/${runId}/trace`);
  }
}
