import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { demoCompanies, demoToken, disableDemoDotenv, prepareDemoEnvironment, reportDemoFailure, verifyDemoDatabase } from './demo-guard';

const password = 'Demo-local-2026!'; // Public local-demo credential; never used outside the guarded demo DB.
const chatId = '12025550145';

async function main() {
  prepareDemoEnvironment();
  disableDemoDotenv();
  const requireBackend = createRequire(path.resolve(__dirname, '../WhatsaapWeb-JS/package.json'));
  const { hashPassword } = requireBackend('./src/utils/password');
  const { default: pool } = await import('../WhatsaapWeb-JS/src/config/database');
  try {
    await verifyDemoDatabase(pool);
    const { CatalogRepositoryPg } = await import('../WhatsaapWeb-JS/src/modules/inventory/infra/db/CatalogRepositoryPg');
    const { ProductRepositoryPg } = await import('../WhatsaapWeb-JS/src/modules/inventory/infra/db/ProductRepositoryPg');
    const { MetaAccountStore } = await import('../WhatsaapWeb-JS/src/services/whatsapp/meta/MetaAccountStore');
    const { MetaInboxStore } = await import('../WhatsaapWeb-JS/src/services/whatsapp/meta/MetaInboxStore');
    const { saveDraft } = await import('../WhatsaapWeb-JS/src/services/ai/studio/AgentStudioDrafts');
    const { boundedTextBudget, boundedTextCapability } = await import('../WhatsaapWeb-JS/src/services/ai/gateway/BoundedTextCompletion');
    const hash = await hashPassword(password);
    // Runtime media belongs in the persisted uploads volume, never in source.
    const mediaDir = path.resolve(__dirname, '../WhatsaapWeb-JS/uploads/commercial-items');
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, 'demo-local-product.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#10231a"/><path d="M160 170h160l-35-85h-90z" fill="#ade1b9"/><path d="M235 170h10v90h-10zM195 260h90v12h-90z" fill="#d5e9d9"/></svg>',
      { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const client = await pool.connect();
    const seeded: { companyId: number; line: string; name: string }[] = [];
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('whatsap-local-demo-seed-v1', 0))");
      for (const [index, company] of demoCompanies.entries()) {
        // companies is the provisioning root, matching AuthService.register.
        await client.query("SELECT set_config('app.login_email',$1,true)", [company.email]);
        let { rows: [row] } = await client.query('SELECT company_id AS id FROM usuarios WHERE email=$1 LIMIT 1', [company.email]);
        if (!row) ({ rows: [row] } = await client.query('SELECT id FROM companies WHERE name=$1 ORDER BY id LIMIT 1', [company.name]));
        if (!row) ({ rows: [row] } = await client.query('INSERT INTO companies(name) VALUES($1) RETURNING id', [company.name]));
        const companyId = Number(row.id);
        await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [String(companyId)]);
        await client.query('INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [companyId, company.name, `demo-company-${companyId}`]);
        await client.query("INSERT INTO workspaces(tenant_id,name,slug,is_default) VALUES($1,'Principal','default',true) ON CONFLICT(tenant_id,slug) DO NOTHING", [companyId]);
        await client.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,company_id,activo)
          VALUES($1,$2,$3,'ADMIN',$4,true) ON CONFLICT(email) DO NOTHING`, [company.name, company.email, hash, companyId]);
        const { rows: [admin] } = await client.query('SELECT id FROM usuarios WHERE company_id=$1 AND email=$2', [companyId, company.email]);
        if (!admin) throw new Error('DEMO_SEED_IDENTITY_CONFLICT');
        await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT(tenant_id,user_id) DO NOTHING", [companyId, admin.id]);
        if (index === 0) {
          await client.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,id_padre,company_id,activo)
            VALUES($1,$2,$3,'EMPLEADO',$4,$5,true) ON CONFLICT(email) DO NOTHING`,
          ['Operador Demo', 'operador@automat.local', hash, admin.id, companyId]);
          const { rows: [operator] } = await client.query('SELECT id FROM usuarios WHERE company_id=$1 AND email=$2', [companyId, 'operador@automat.local']);
          if (!operator) throw new Error('DEMO_SEED_IDENTITY_CONFLICT');
          await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(tenant_id,user_id) DO NOTHING", [companyId, operator.id]);
        }
        // Stable metadata identifies seed rows even if their visible names change.
        let { rows: [catalog] } = await client.query("SELECT id FROM catalogs WHERE company_id=$1 AND metadata_json->>'demoSeed'=$2 LIMIT 1", [companyId, 'local-catalog-v1']);
        if (!catalog) catalog = await new CatalogRepositoryPg(client).create(companyId, {
          name: 'Colección local', description: `Productos ficticios de ${company.name}`, status: 'active', aiEnabled: true,
          metadata: { demoSeed: 'local-catalog-v1' },
        });
        for (const item of [{ sku: 'DEMO-LAMPARA', name: 'Lámpara', price: 89 }, { sku: 'DEMO-MESA', name: 'Mesa', price: 149 }]) {
          const { rows } = await client.query("SELECT id FROM products WHERE company_id=$1 AND (metadata_json->>'demoSeed'=$2 OR sku=$3) LIMIT 1", [companyId, item.sku, item.sku]);
          if (!rows.length) await new ProductRepositoryPg(client).create(companyId, {
            name: `${item.name} · ${company.name}`, sku: item.sku, description: 'Producto ficticio para desarrollo local.',
            price: item.price, currency: 'PEN', status: 'active', itemType: 'physical_product', aiEnabled: true,
            aiDescription: 'Artículo de demostración; no constituye una oferta comercial.', stockAvailable: 12,
            imageUrl: '/uploads/commercial-items/demo-local-product.svg', imageAltText: 'Ilustración de producto de demostración',
            catalogAssignments: [{ catalogId: Number(catalog.id) }], metadata: { demoSeed: item.sku },
          });
        }
        await client.query(`INSERT INTO tenant_ai_quotas(tenant_id,monthly_token_limit,monthly_cost_limit_micro_usd)
          VALUES($1,20000000,20000000) ON CONFLICT(tenant_id) DO NOTHING`, [companyId]);
        const budget = boundedTextBudget(128, 1500)!;
        await saveDraft(client, companyId, Number(admin.id), 'demo-text-assistant', {
          entryNodeId: 'answer', policyRef: 'demo-local-only',
          nodes: [
            { id: 'answer', kind: 'agent', config: { provider: 'openai', model: boundedTextCapability.model, maxTokens: 128, timeoutMs: 1500,
              prompt: 'Demostración local. Ofrece una respuesta breve e indica que es simulada.' } },
            { id: 'end', kind: 'end', config: {} },
          ],
          edges: [{ id: 'finish', from: 'answer', to: 'end' }],
          limits: { maxSteps: 2, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10,
            maxModelTokens: budget.maxTokens, maxCostMicroUsd: budget.maxCostMicroUsd },
        }, true); // Existing graph/revisions are never changed.
        seeded.push({ companyId, line: company.line, name: company.name });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }

    // Store helpers apply their own tenant scope. Preserve edited connections/history.
    const { TenantScopedUoW } = await import('../WhatsaapWeb-JS/src/db/TenantScopedUoW');
    const scope = new TenantScopedUoW(pool);
    for (const company of seeded) {
      const exists = await scope.run(company.companyId, (db) => db.query(
        "SELECT id FROM whatsapp_business_accounts WHERE company_id=$1 AND provider='meta-cloud' LIMIT 1", [company.companyId]));
      if (!exists.rows.length) await new MetaAccountStore(pool).upsertConnection(company.companyId, {
        phoneNumberId: company.line, accessToken: demoToken, graphVersion: 'v25.0', status: 'configured',
        displayPhoneNumber: '+1 202 555 0145', metadata: { demoSeed: 'local-connection-v1' },
      });
      await new MetaInboxStore({ db: pool, companyId: company.companyId }).persistInboundMessage({
        message: { from: chatId, id: 'wamid.demo.seed.welcome', timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text', text: { body: `Consulta de ${company.name}: ¿tienen esta lámpara disponible?` } },
        contact: { wa_id: chatId, profile: { name: 'Lucía Demo' } },
        // History only; seed does not schedule automatic sends or provider work.
        metadata: {}, value: {},
      });
    }
    console.info('Demo seed complete: two companies, local users, catalog and conversation; existing data preserved.');
  } finally { await pool.end(); }
}

void main().catch((error: unknown) => reportDemoFailure('Demo seed', error));
