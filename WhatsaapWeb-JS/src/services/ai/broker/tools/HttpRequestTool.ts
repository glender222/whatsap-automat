import { ToolDefinitionV1 } from '@whatsap-automat/contracts';
import { IToolImplementation, ToolValidationResult } from '../types';
import { SafeHttpClient } from '../SafeHttpClient';

export class HttpRequestTool implements IToolImplementation {
  readonly definition: ToolDefinitionV1 = {
    schemaVersion: 1,
    name: 'http_request',
    description: 'Reads an external HTTP or HTTPS resource with GET or HEAD through the SSRF egress firewall.',
    riskLevel: 'read',
    requiredRoles: ['agent', 'admin'],
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        method: { type: 'string', enum: ['GET', 'HEAD'], default: 'GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 10000, default: 10000 },
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
    if (typeof input.url !== 'string' || input.url.trim().length === 0 || input.url.length > 4096) {
      errors.push("Missing or invalid required parameter 'url'");
    }
    if (input.method !== undefined &&
        (typeof input.method !== 'string' || !['GET', 'HEAD'].includes(input.method.toUpperCase()))) {
      errors.push('Only GET and HEAD are supported');
    }
    if (input.body !== undefined && input.body !== null) errors.push('Request bodies are not supported');
    if (input.headers !== undefined && (!input.headers || typeof input.headers !== 'object' ||
        Array.isArray(input.headers) || Object.values(input.headers).some((value) => typeof value !== 'string'))) {
      errors.push('Headers must be an object of string values');
    }
    if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < 500 || input.timeoutMs > this.definition.timeoutMs)) {
      errors.push(`Timeout must be between 500 and ${this.definition.timeoutMs} ms`);
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(input: Record<string, unknown>): Promise<unknown> {
    const validation = this.validateInput(input);
    if (!validation.valid) throw new Error(validation.errors?.join(', '));
    const response = await SafeHttpClient.request(String(input.url), {
      method: typeof input.method === 'string' ? input.method.toUpperCase() : 'GET',
      headers: input.headers as Record<string, string> | undefined,
      timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : this.definition.timeoutMs,
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
