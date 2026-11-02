import { ModelGatewayRequest, AdapterRawResult } from '../types';

export interface IModelAdapter {
  readonly provider: string;
  complete(request: ModelGatewayRequest): Promise<AdapterRawResult>;
}
