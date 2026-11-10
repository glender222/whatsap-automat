import './testEnv';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { ToolBroker } from '../../services/ai/broker/ToolBroker';
import { ToolRegistry } from '../../services/ai/broker/ToolRegistry';
import { EffectCache } from '../../services/ai/broker/EffectCache';

type Input = {
  tenantId: number; effectKey: string; runId: string; log: string;
  mode: 'hold' | 'crash' | 'complete' | 'completion_ack_lost' | 'completion_not_saved' | 'late';
  toolInput?: Record<string, unknown>; timeoutMs?: number;
};
const input = JSON.parse(process.argv[2]) as Input;
const connection = new URL(process.env.TOOL_BROKER_TEST_DATABASE_URL!);
assert.equal(connection.hostname, '127.0.0.1');
assert.ok(connection.pathname.endsWith('_smoke'));
assert.ok(input.log.startsWith('/tmp/tool-broker-effects-'));
const db = new Pool({ connectionString: connection.toString() });
const uow = new TenantScopedUoW(db);
const registry = new ToolRegistry(uow);
const released = new Promise<void>((resolve) => process.once('message', () => resolve()));
let physicalEffectSettled!: () => void;
const physicalEffect = new Promise<void>((resolve) => { physicalEffectSettled = resolve; });
registry.registerTool({
  definition: {
    schemaVersion: 1, name: 'fixture_local_effect', description: 'Append one local synthetic receipt',
    riskLevel: 'write', requiredRoles: ['admin'], parameters: { type: 'object' },
    timeoutMs: input.timeoutMs ?? 60_000, isEgressNetworkTool: false,
  },
  validateInput: () => ({ valid: true }),
  async execute() {
    if (input.mode === 'late') await new Promise((resolve) => setTimeout(resolve, 200));
    await appendFile(input.log, `${input.tenantId}:${input.effectKey}\n`);
    physicalEffectSettled();
    process.send?.({ event: 'effect' });
    if (input.mode === 'crash') process.kill(process.pid, 'SIGKILL');
    if (input.mode === 'hold') await released;
    return { receipt: 'local-synthetic-effect', tenantId: input.tenantId, input: input.toolInput ?? {} };
  },
}, input.tenantId);

async function main() {
  const effectCache = new EffectCache(uow);
  if (input.mode === 'completion_ack_lost' || input.mode === 'completion_not_saved') {
    const save = effectCache.complete.bind(effectCache);
    effectCache.complete = async (...args) => {
      if (input.mode === 'completion_ack_lost') await save(...args);
      throw new Error('Synthetic loss of completion persistence acknowledgement');
    };
  }
  const result = await new ToolBroker({ uow, registry, effectCache }).execute({
    tenantId: String(input.tenantId), runId: input.runId, agentGraphId: 'fixture-broker-effects',
    toolName: 'fixture_local_effect', actorRoles: ['admin'], effectKey: input.effectKey, input: input.toolInput ?? {},
    currentStep: 1, currentTokensUsed: 0,
  });
  if (input.mode === 'late') await physicalEffect;
  await db.end();
  process.send?.({ event: 'result', result }, () => process.exit(0));
}
void main().catch(() => {
  process.send?.({ event: 'error' }, () => process.exit(1));
});
