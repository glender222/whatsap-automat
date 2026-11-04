import { HttpClient, HttpClientOptions } from './http';
import { ConversationsResource } from './resources/conversations';
import { ChannelsResource } from './resources/channels';
import { AgentsResource } from './resources/agents';
import { WorkflowsResource } from './resources/workflows';
import { ApprovalsResource } from './resources/approvals';

export interface AutomatClientOptions extends HttpClientOptions {}

export class AutomatClient {
  readonly http: HttpClient;
  readonly conversations: ConversationsResource;
  readonly channels: ChannelsResource;
  readonly agents: AgentsResource;
  readonly workflows: WorkflowsResource;
  readonly approvals: ApprovalsResource;

  constructor(options: AutomatClientOptions) {
    this.http = new HttpClient(options);
    this.conversations = new ConversationsResource(this.http);
    this.channels = new ChannelsResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.workflows = new WorkflowsResource(this.http);
    this.approvals = new ApprovalsResource(this.http);
  }

  static create(options: AutomatClientOptions): AutomatClient {
    return new AutomatClient(options);
  }
}
