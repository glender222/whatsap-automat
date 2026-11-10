import { ByokService } from './byok/ByokService';
import { QuotaManager } from './QuotaManager';
import { TokenCostLedger } from './TokenCostLedger';
import { CostCalculator } from './CostCalculator';
import { deniedStrictCapability, type ModelGatewayAdmission, type StrictModelGateway } from './StrictModelGateway';
import { IModelAdapter } from './adapters/IModelAdapter';
import { OpenAiAdapter } from './adapters/OpenAiAdapter';
import { AnthropicAdapter } from './adapters/AnthropicAdapter';
import { LocalOpenAiAdapter } from './adapters/LocalOpenAiAdapter';
import { FetchFunction } from './adapters/BaseModelAdapter';
import {
  IModelGateway,
  ModelGatewayRequest,
  ModelCompletionResult,
  ResolvedCredential,
  AdapterRawResult,
  ModelProvider,
  TestByokConnectionRequestV1,
  TestByokConnectionResultV1,
  EmbeddingRequest,
  EmbeddingResult,
} from './types';
import { modelGatewayRequestSchema } from '@whatsap-automat/contracts';
import { createTenantBoundedModelExecution } from './TenantBoundedModelExecution';

export class ModelGateway implements IModelGateway {
  constructor(
    private readonly byokService: ByokService = new ByokService(),
    private readonly quotaManager: QuotaManager = new QuotaManager(),
    private readonly ledger: TokenCostLedger = new TokenCostLedger(),
    private readonly customFetch?: FetchFunction,
    private readonly embeddingMode: 'provider' | 'synthetic' = 'provider',
    private readonly admission?: ModelGatewayAdmission,
  ) {}

  /**
   * Neutral facade execution method.
   * Enforces monthly quota limits, resolves BYOK secrets, dispatches provider adapter,
   * calculates integer micro-USD costs, and records immutable audit ledger entries.
   */
  async complete(rawRequest: ModelGatewayRequest): Promise<ModelCompletionResult> {
    const parseResult = modelGatewayRequestSchema.safeParse(rawRequest);
    if (!parseResult.success) {
      const err = new Error(
        `Invalid ModelGateway request: ${JSON.stringify(parseResult.error.issues)}`
      ) as any;
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    const request = parseResult.data;
    const tenantId = Number(request.tenantId);
    const startTime = Date.now();
    const strict = await this.resolveAdmission(tenantId);
    if (strict) return strict.complete(tenantId, request);
    return this.withLegacyDispatch(tenantId, () => this.completeLegacy(tenantId, request, startTime));
  }

  private async completeLegacy(tenantId: number, request: ModelGatewayRequest, startTime: number): Promise<ModelCompletionResult> {
    // 1. Enforce atomic quota limit before dispatching
    await this.quotaManager.assertWithinQuota(tenantId);

    // 2. Resolve credentials (BYOK or fallback)
    const creds = await this.byokService.resolveDecryptedCredential(
      tenantId,
      request.provider as ModelProvider
    );

    if (!creds.apiKey && (request.provider === 'openai' || request.provider === 'anthropic')) {
      const err = new Error(
        `Missing API key for provider '${request.provider}'. Configure BYOK credentials in /api/v1/ai/providers`
      ) as any;
      err.statusCode = 400;
      err.code = 'CREDENTIAL_MISSING';
      throw err;
    }

    // 3. Resolve adapter
    const adapter = this.resolveAdapter(request.provider as ModelProvider, creds);

    // 4. Dispatch with timeout and error handling
    let rawResult: AdapterRawResult;
    try {
      rawResult = await adapter.complete(request);
    } catch (adapterError: any) {
      const latencyMs = Date.now() - startTime;
      let status: 'failed' | 'timeout' | 'rate_limited' = 'failed';
      if (adapterError.code === 'TIMEOUT') status = 'timeout';
      else if (adapterError.code === 'RATE_LIMITED') status = 'rate_limited';

      // Record failed transaction in ledger for auditing
      try {
        await this.ledger.record({
          tenantId,
          workspaceId: request.workspaceId ? Number(request.workspaceId) : undefined,
          agentRunId: request.agentRunId || undefined,
          conversationId: request.conversationId ? Number(request.conversationId) : undefined,
          provider: request.provider,
          model: request.model,
          operation: 'completion',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costMicroUsd: 0,
          isByok: creds.isByok,
          latencyMs,
          status,
          metadataJson: { error: adapterError.message, code: adapterError.code },
        });
      } catch (logErr) {
        // Do not mask original adapter error if ledger write fails
        console.error('[ModelGateway] Failed to record failure ledger entry:', logErr);
      }

      throw adapterError;
    }

    const latencyMs = Date.now() - startTime;

    // 5. Calculate integer micro-USD cost
    const costMicroUsd = CostCalculator.calculate(
      request.model,
      rawResult.usage.promptTokens,
      rawResult.usage.completionTokens
    );

    // 6. Record immutable ledger entry
    await this.ledger.record({
      tenantId,
      workspaceId: request.workspaceId ? Number(request.workspaceId) : undefined,
      agentRunId: request.agentRunId || undefined,
      conversationId: request.conversationId ? Number(request.conversationId) : undefined,
      provider: request.provider,
      model: request.model,
      operation: 'completion',
      promptTokens: rawResult.usage.promptTokens,
      completionTokens: rawResult.usage.completionTokens,
      totalTokens: rawResult.usage.totalTokens,
      costMicroUsd,
      isByok: creds.isByok,
      latencyMs,
      status: 'success',
      metadataJson: { finishReason: rawResult.finishReason },
    });

    // 7. Atomically consume quota
    await this.quotaManager.consume(tenantId, costMicroUsd, rawResult.usage.totalTokens);

    return {
      text: rawResult.text,
      toolCalls: rawResult.toolCalls as any,
      usage: rawResult.usage,
      costMicroUsd,
      provider: request.provider,
      model: request.model,
      finishReason: rawResult.finishReason,
      latencyMs,
    };
  }

  /**
   * Ephemeral test connection helper.
   */
  async testConnection(
    tenantId: number,
    params: TestByokConnectionRequestV1
  ): Promise<TestByokConnectionResultV1> {
    const startTime = Date.now();
    try {
      const strict = await this.resolveAdmission(tenantId);
      if (strict) return await strict.testConnection(tenantId, params);
      return await this.withLegacyDispatch(tenantId, () => this.testLegacyConnection(tenantId, params, startTime));
    } catch (err: any) {
      return {
        ok: false,
        provider: params.provider,
        latencyMs: Date.now() - startTime,
        errorMessage: err.message,
      };
    }
  }

  private async testLegacyConnection(
    tenantId: number, params: TestByokConnectionRequestV1, startTime: number,
  ): Promise<TestByokConnectionResultV1> {
    let resolvedApiKey = params.apiKey;
    let resolvedBaseUrl = params.baseUrl;

    // If apiKey or baseUrl not provided in test request, load from tenant config
    if (!resolvedApiKey && !resolvedBaseUrl) {
      const creds = await this.byokService.resolveDecryptedCredential(tenantId, params.provider);
      resolvedApiKey = creds.apiKey || undefined;
      resolvedBaseUrl = creds.baseUrl || undefined;
    }

    const creds: ResolvedCredential = {
      apiKey: resolvedApiKey || null,
      baseUrl: resolvedBaseUrl || null,
      defaultModel: params.model || null,
      isByok: true,
    };

    const adapter = this.resolveAdapter(params.provider, creds);
    await adapter.complete({
      schemaVersion: 1,
      tenantId,
      provider: params.provider,
      model: params.model || (params.provider === 'openai' ? 'gpt-4o-mini' : (params.provider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'default')),
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      timeoutMs: 10000,
    });

    return {
      ok: true,
      provider: params.provider,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Neutral embedding execution method.
   * Enforces monthly quota limits, resolves BYOK secrets, generates 1536-dimensional embeddings,
   * computes integer micro-USD costs, and records immutable audit ledger entries.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const tenantId = Number(request.tenantId);
    if (await this.resolveAdmission(tenantId)) {
      throw deniedStrictCapability('A bounded embedding profile is unavailable');
    }
    return this.withLegacyDispatch(tenantId, () => this.embedLegacy(tenantId, request));
  }

  private async embedLegacy(tenantId: number, request: EmbeddingRequest): Promise<EmbeddingResult> {
    const provider = request.provider || 'openai';
    const model = request.model || (provider === 'local_openai' ? 'nomic-embed-text' : 'text-embedding-3-small');
    const startTime = Date.now();
    const synthetic = this.embeddingMode === 'synthetic';

    try {
      await this.quotaManager.assertWithinQuota(tenantId);
    } catch (error: any) {
      if (!synthetic || error.code === 'RATE_LIMITED' || error.statusCode === 429) throw error;
    }

    let creds: ResolvedCredential = { apiKey: null, baseUrl: null, defaultModel: null, isByok: false };
    try {
      creds = await this.byokService.resolveDecryptedCredential(tenantId, provider);
    } catch (error) {
      if (!synthetic) throw error;
    }

    const totalChars = request.input.reduce((sum, text) => sum + text.length, 0);
    let promptTokens = Math.max(1, Math.ceil(totalChars / 4));
    let embeddings: number[][];

    if (synthetic) {
      embeddings = request.input.map((text) => this.generateDeterministicVector(text));
    } else {
      if (provider !== 'openai') {
        throw Object.assign(new Error('Embedding provider is unavailable'), { statusCode: 422, code: 'EMBEDDING_PROVIDER_UNAVAILABLE' });
      }
      if (!creds.apiKey) {
        throw Object.assign(new Error('Configure a tenant embedding credential before using the knowledge base'), {
          statusCode: 400, code: 'CREDENTIAL_MISSING',
        });
      }

      const fetchFn = this.customFetch || globalThis.fetch;
      let response: Response;
      try {
        response = await fetchFn('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
          body: JSON.stringify({ model, input: request.input }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw Object.assign(new Error('Embedding provider is unreachable'), { statusCode: 502, code: 'EMBEDDING_REQUEST_FAILED' });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`Embedding provider rejected the request (HTTP ${response.status})`), {
          statusCode: response.status === 429 ? 429 : 502, code: 'EMBEDDING_REQUEST_FAILED',
        });
      }

      const data = (await response.json()) as { data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number } };
      const vectors = Array.isArray(data.data) ? [...data.data].sort((left, right) => left.index - right.index) : [];
      if (vectors.length !== request.input.length || !vectors.every((item, index) =>
        item.index === index && Array.isArray(item.embedding) && item.embedding.length > 0 && item.embedding.every(Number.isFinite)
      )) {
        throw Object.assign(new Error('Embedding provider returned invalid vectors'), {
          statusCode: 502, code: 'EMBEDDING_RESPONSE_INVALID',
        });
      }
      embeddings = vectors.map((item) => item.embedding);
      const reportedTokens = data.usage?.prompt_tokens;
      if (typeof reportedTokens === 'number' && Number.isSafeInteger(reportedTokens) && reportedTokens >= 0) {
        promptTokens = reportedTokens;
      }
    }

    const costMicroUsd = CostCalculator.calculate(model, promptTokens, 0);
    const latencyMs = Date.now() - startTime;
    try {
      await this.ledger.record({
        tenantId, provider, model,
        operation: 'embedding',
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        costMicroUsd,
        isByok: creds.isByok,
        latencyMs,
        status: 'success',
        metadataJson: { inputCount: request.input.length },
      });
      await this.quotaManager.consume(tenantId, costMicroUsd, promptTokens);
    } catch (error) {
      if (!synthetic) throw error;
    }

    return {
      embeddings,
      usage: { promptTokens, totalTokens: promptTokens },
      costMicroUsd,
      provider,
      model,
      latencyMs,
    };
  }

  private async resolveAdmission(tenantId: number): Promise<StrictModelGateway | null> {
    if (!this.admission) return null;
    let mode: Awaited<ReturnType<ModelGatewayAdmission['modeForTenant']>>;
    try {
      mode = await this.admission.modeForTenant(tenantId);
    } catch {
      throw Object.assign(new Error('AI quota admission could not be verified'), { code: 'AI_ADMISSION_UNAVAILABLE', statusCode: 503 });
    }
    if (mode === 'legacy') return null;
    if (mode === 'strict') return this.admission.strict;
    throw Object.assign(new Error('AI provider dispatch is unavailable for this tenant'), { code: 'AI_ADMISSION_UNAVAILABLE', statusCode: 503 });
  }

  private withLegacyDispatch<T>(tenantId: number, operation: () => Promise<T>): Promise<T> {
    return this.admission?.withLegacyDispatch?.(tenantId, operation) ?? operation();
  }

  /**
   * Deterministically generates an L2-normalized 1536-dimensional vector for a string.
   */
  generateDeterministicVector(text: string): number[] {
    const dim = 1536;
    const vector = new Array<number>(dim);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
    }
    let sumSq = 0;
    for (let i = 0; i < dim; i++) {
      hash = (hash * 1664525 + 1013904223) & 0xffffffff;
      const val = (hash / 0x7fffffff) - 1.0;
      vector[i] = val;
      sumSq += val * val;
    }
    const norm = Math.sqrt(sumSq) || 1.0;
    for (let i = 0; i < dim; i++) {
      vector[i] = Number((vector[i] / norm).toFixed(6));
    }
    return vector;
  }


  /**
   * Resolves the appropriate provider adapter.
   */
  private resolveAdapter(provider: ModelProvider, creds: ResolvedCredential): IModelAdapter {
    switch (provider) {
      case 'openai':
        return new OpenAiAdapter(creds.apiKey, creds.baseUrl, this.customFetch);
      case 'anthropic':
        return new AnthropicAdapter(creds.apiKey, creds.baseUrl, this.customFetch);
      case 'local_openai':
        return new LocalOpenAiAdapter(creds.apiKey, creds.baseUrl, this.customFetch);
      default:
        throw new Error(`Unsupported model provider: '${provider}'`);
    }
  }
}

export const modelGateway = new ModelGateway(undefined, undefined, undefined, undefined, undefined,
  createTenantBoundedModelExecution().admission);
