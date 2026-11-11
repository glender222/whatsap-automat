import { installDemoNetwork } from './demo-network';
import { createDemoCorsOrigin, disableDemoDotenv, prepareDemoEnvironment, reportDemoFailure, verifyDemoDatabase } from './demo-guard';

async function main() {
  prepareDemoEnvironment();
  disableDemoDotenv();
  installDemoNetwork();
  const { default: pool } = await import('../WhatsaapWeb-JS/src/config/database');
  await verifyDemoDatabase(pool);
  const { boundedTextCapability } = await import('../WhatsaapWeb-JS/src/services/ai/gateway/BoundedTextCompletion');
  const { tenantScopedUoW } = await import('../WhatsaapWeb-JS/src/db/TenantScopedUoW');
  const { createStudioVerification } = await import('../WhatsaapWeb-JS/src/services/ai/studio/StudioVerification');
  const { App } = await import('../WhatsaapWeb-JS/src/app');
  const { default: config } = await import('../WhatsaapWeb-JS/src/config/index');
  const origin = createDemoCorsOrigin(process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173,http://web:5173');
  // Adapt only this guarded composition; production config and App remain untouched.
  if (!Reflect.set(config.cors, 'origin', origin)) throw new Error('DEMO_CORS_ORIGIN_REJECTED');
  const verification = createStudioVerification(tenantScopedUoW, {
    capabilityId: boundedTextCapability.id,
    async complete(_request, signal) {
      signal.throwIfAborted();
      return { usage: { promptTokens: 12, completionTokens: 12, cachedTokens: 0 },
        output: { text: 'Respuesta simulada local. Consulta recibida; tu equipo conserva el control.', finishReason: 'stop' } };
    },
  });
  console.info('DEMO local: Graph e IA simulados; las salidas HTTP externas están bloqueadas.');
  await new App(verification).start();
}

void main().catch((error: unknown) => {
  reportDemoFailure('Local demo', error);
  // Fail closed even when an imported module has opened pool connections.
  process.exit(1);
});
