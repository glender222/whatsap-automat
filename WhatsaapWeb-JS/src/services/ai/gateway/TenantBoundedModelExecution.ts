import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { AiQuotaReservationStore } from './AiQuotaReservationStore';
import { ByokService } from './byok/ByokService';
import { OpenAiBoundedTextAdapter } from './adapters/OpenAiBoundedTextAdapter';
import type { FetchFunction } from './adapters/BaseModelAdapter';
import { StrictModelGateway, type ModelGatewayAdmission } from './StrictModelGateway';
import { TenantAiDispatchPolicy } from './TenantAiDispatchPolicy';

export function createTenantBoundedModelExecution(uow: TenantScopedUoW = tenantScopedUoW, fetchProvider?: FetchFunction) {
  const policy = new TenantAiDispatchPolicy(uow);
  const byok = new ByokService(undefined, uow);
  const quota = new AiQuotaReservationStore(uow, undefined, (db, tenantId) => policy.assertStrict(db, tenantId));

  async function resolveTransport({ tenantId, probeApiKey }: { tenantId: number; probeApiKey?: string }) {
    if (await policy.mode(tenantId) !== 'strict') throw new Error('Bounded provider policy is inactive');
    const credential = probeApiKey === undefined ? await byok.resolveDecryptedCredential(tenantId, 'openai') : null;
    const key = probeApiKey ?? (credential?.isByok && !credential.baseUrl ? credential.apiKey : null);
    if (!key || /[\u0000-\u0020\u007f-\uffff]/u.test(key)) throw new Error('Tenant provider credential is unavailable');

    return {
      isByok: true,
      adapter: new OpenAiBoundedTextAdapter((url, init) => {
        if (url !== 'https://api.openai.com/v1/chat/completions' || init?.redirect !== 'error') {
          throw new Error('Bounded provider destination is invalid');
        }
        const headers = new Headers(init.headers);
        headers.set('Authorization', 'Bearer ' + key);
        return (fetchProvider ?? globalThis.fetch)(url, { ...init, headers });
      }),
    };
  }

  const admission: ModelGatewayAdmission = {
    async modeForTenant(tenantId) {
      const mode = await policy.mode(tenantId);
      return mode === 'paused' ? 'draining' : mode;
    },
    strict: new StrictModelGateway(quota, resolveTransport),
    withLegacyDispatch: (tenantId, operation) => policy.withLegacyDispatch(tenantId, operation),
  };
  return { policy, quota, resolveTransport, admission };
}
