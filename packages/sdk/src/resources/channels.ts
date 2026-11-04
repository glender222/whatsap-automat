import { ChannelConnectionV1, ChannelConnectionHealthV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';

export class ChannelsResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<ChannelConnectionV1[]> {
    const res = await this.http.get<{ items: ChannelConnectionV1[] }>('/channel-connections');
    return res.items ?? (res as unknown as ChannelConnectionV1[]);
  }

  async get(id: string): Promise<ChannelConnectionV1> {
    return this.http.get<ChannelConnectionV1>(`/channel-connections/${id}`);
  }

  async validate(id: string): Promise<ChannelConnectionHealthV1> {
    return this.http.post<ChannelConnectionHealthV1>(`/channel-connections/${id}/validate`);
  }
}
