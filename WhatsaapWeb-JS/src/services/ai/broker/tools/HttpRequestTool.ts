import { ToolDefinitionV1 } from '@whatsap-automat/contracts';
import { IToolImplementation, ToolExecutionContext, ToolValidationResult } from '../types';
import { SafeHttpClient } from '../SafeHttpClient';

export class HttpRequestTool implements IToolImplementation {
  readonly definition: ToolDefinitionV1 = {
    schemaVersion: 1,
    name: 'http_request',
    description: 'Performs an external HTTP or HTTPS request protected by the bitwise CIDR SSRF egress firewall.',
    riskLevel: 'write',
    requiredRoles: ['agent', 'admin'],
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
        headers: { type: 'object' },
        body: { type: ['string', 'object'] },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 30000, default: 5000 },
      },
    },
    timeoutMs: 10000,
    isEgressNetworkTool: true,
  };

  validateInput(input: Record<string, unknown>): ToolValidationResult {
    const errors: string[] = [];
    if (!input || typeof input !== 'object') {
      return { valid: false, errors: ['Input must be an object'] };
    }
    if (!input.url || typeof input.url !== 'string' || input.url.trim().length === 0) {
      errors.push("Missing or invalid required parameter 'url'");
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const url = String(input.url);
    const method = input.method ? String(input.method) : 'GET';
    const headers = (input.headers as Record<string, string>) || {};
    let body: string | undefined = undefined;

    if (input.body !== undefined && input.body !== null) {
      body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    }

    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : this.definition.timeoutMs;

    const response = await SafeHttpClient.request(url, {
      method,
      headers,
      body,
      timeoutMs,
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      finalUrl: response.finalUrl,
      redirectCount: response.redirectCount,
      resolvedIp: response.resolvedIp,
    };
  }
}
