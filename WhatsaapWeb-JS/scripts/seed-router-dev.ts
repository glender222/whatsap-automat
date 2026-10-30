/**
 * Script opcional de DEV/TEST para crear agente router por compañia.
 *
 * NO es migracion productiva. Uso exclusivo desarrollo/testing.
 * Produccion sin router configurado => IA apagada + log router_missing.
 *
 * Ejecutar con:
 *   npx tsx scripts/seed-router-dev.ts
 *
 * Requiere: PostgreSQL corriendo con migraciones aplicadas.
 */

import 'dotenv/config';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const aiProvider = String(process.env.AI_PROVIDER || 'opencode').trim().toLowerCase();
  if (aiProvider !== 'openai' && aiProvider !== 'opencode') {
    throw new Error('AI_PROVIDER debe ser openai u opencode');
  }
  const aiModel = String(
    aiProvider === 'openai' ? process.env.OPENAI_MODEL || '' : process.env.OPENCODE_MODEL || ''
  ).trim() || null;
  const databasePassword = String(process.env.DB_PASSWORD || '').trim();
  if (!databasePassword) throw new Error('Variable de entorno requerida: DB_PASSWORD');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'whatsapp_empresas',
    user: process.env.DB_USER || 'postgres',
    password: databasePassword,
  });

  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL conectado');
  } catch (err: any) {
    console.warn('⚠️ PostgreSQL no disponible', {
      code: String(err?.code || 'DB_UNAVAILABLE'),
    });
    await pool.end();
    process.exit(0);
  }

  try {
    const companies = await pool.query(
      `SELECT id FROM companies WHERE is_active = true ORDER BY id`
    );
    console.log(`\nCompañías activas: ${companies.rows.length}`);

    let created = 0;
    let skipped = 0;

    for (const row of companies.rows) {
      const companyId = Number(row.id);

      const existing = await pool.query(
        `SELECT id, name, status, mode FROM ai_agents
         WHERE company_id = $1 AND purpose = 'router' AND status <> 'archived'
         ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
        [companyId]
      );

      const activeRouter = existing.rows.find(
        (a) => a.status === 'active' && a.mode !== 'disabled'
      );

      if (activeRouter) {
        console.log(`  [cid=${companyId}] router activo ya existe (id=${activeRouter.id}), skip.`);
        skipped++;
        continue;
      }

      const result = await pool.query(
        `INSERT INTO ai_agents (
           company_id, name, status, mode, provider, model, purpose,
           module_access_json, trigger_rules_json, catalog_scope_json, tool_access_json,
           is_default, created_by
         )
         VALUES (
           $1, 'Router IA', 'active', 'suggest', $2, $3, 'router',
           $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
           false, NULL
         )
         RETURNING id`,
        [
          companyId,
          aiProvider,
          aiModel,
          JSON.stringify({
            catalog: false,
            orders: false,
            customerHistory: false,
            tags: false,
            handoff: true,
            paymentsRead: false,
            reportsRead: false,
            commercialState: false,
          }),
          JSON.stringify({ commercialIntent: 'never', handoffForPayment: true }),
          JSON.stringify({ catalogIds: [], sectionIds: [] }),
          JSON.stringify({
            catalogSearch: false,
            catalogGetItem: false,
            catalogRecommendAlternatives: false,
            availabilityCheck: false,
            messageSendProductCard: false,
            orderUpsertPreorder: false,
            handoffCreate: true,
            conversationSetCommercialState: false,
            tagApplySystem: false,
            timelineRecord: true,
          }),
        ]
      );

      const routerId = result.rows[0].id;

      await pool.query(
        `INSERT INTO agent_prompt_profiles (
           agent_id, business_description, communication_style, selling_scope,
           forbidden_claims, language, tone, style, welcome_message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          routerId,
          'Agente router para clasificacion de intencion y derivacion.',
          'Clasificar y enrutar, no responder directamente al cliente.',
          'Solo enrutamiento.',
          'No confirmar ventas, no recomendar productos, no procesar pagos.',
          'es',
          'tecnico, preciso',
          'clasificador',
          '',
        ]
      );

      await pool.query(
        `INSERT INTO agent_rules (
           agent_id, auto_reply_when, suggest_when, handoff_when,
           business_hours_json, confidence_threshold, blocked_topics,
           sensitive_topics, max_context_messages
         )
         VALUES ($1, '', '', '', $2::jsonb, 0.70, '{}'::text[], '{}'::text[], 12)`,
        [
          routerId,
          JSON.stringify({
            enabled: false,
            timezone: 'America/Lima',
            start: '09:00',
            end: '18:00',
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          }),
        ]
      );

      console.log(`  [cid=${companyId}] router creado (id=${routerId}).`);
      created++;
    }

    console.log(`\nResumen: creados=${created}, omitidos=${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: any) => {
  console.error('❌ Error en seed de router', {
    code: String(err?.code || 'SEED_ROUTER_FAILED'),
  });
  process.exit(1);
});
