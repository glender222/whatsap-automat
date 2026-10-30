import { Pool, QueryResult } from 'pg';
import pool from '../config/database';

/**
 * CoreModel gestiona el DDL additive-only del Operational Core:
 * empresas (tenant), contactos, conversaciones, mensajes, adjuntos, estados y auditoría.
 *
 * Principios:
 * - Solo CREATE IF NOT EXISTS (nunca DROP ni ALTER destructivo).
 * - Todas las tablas llevan company_id para aislamiento de tenant.
 * - UNIQUE constraints para idempotencia de eventos y contactos.
 */
class CoreModel {
  private pool: Pool;

  constructor(poolInstance: Pool) {
    this.pool = poolInstance;
  }

  async createTablesIfNotExists(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Tabla de empresas (tenant mínimo)
      await client.query(`
        CREATE TABLE IF NOT EXISTS companies (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ Tabla companies creada o ya existe');

      // Tenant default configurable vía entorno
      const defaultCompanyId = parseInt(process.env.DEFAULT_COMPANY_ID || '1', 10) || 1;
      await client.query(`
        INSERT INTO companies (id, name)
        VALUES ($1, 'Default Company')
        ON CONFLICT (id) DO NOTHING;
      `, [defaultCompanyId]);
      console.log(`✅ Tenant default company_id=${defaultCompanyId} verificado`);

      // 2. Tabla de contactos
      await client.query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id SERIAL PRIMARY KEY,
          company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          channel VARCHAR(50) NOT NULL,
          external_contact_id VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          phone VARCHAR(50),
          raw_profile_json JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT uq_contacts_company_channel_external
            UNIQUE (company_id, channel, external_contact_id)
        );
      `);
      console.log('✅ Tabla contacts creada o ya existe');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_contacts_company_external
        ON contacts(company_id, channel, external_contact_id);
      `);

      // 3. Tabla de conversaciones
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          channel VARCHAR(50) NOT NULL,
          external_conversation_id VARCHAR(255) NOT NULL,
          contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
          type VARCHAR(50),
          title VARCHAR(255),
          last_message_at TIMESTAMPTZ,
          unread_count INT DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT uq_conversations_company_channel_external
            UNIQUE (company_id, channel, external_conversation_id)
        );
      `);
      console.log('✅ Tabla conversations creada o ya existe');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_conversations_company_last_message
        ON conversations(company_id, last_message_at DESC NULLS LAST);
      `);

      // 4. Tabla de mensajes
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
          direction VARCHAR(20) NOT NULL,
          channel VARCHAR(50) NOT NULL,
          provider_message_id VARCHAR(255),
          client_request_id VARCHAR(255),
          body TEXT,
          message_type VARCHAR(50),
          status VARCHAR(50),
          occurred_at TIMESTAMPTZ DEFAULT NOW(),
          raw_payload_json JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT uq_messages_company_channel_provider_id
            UNIQUE (company_id, channel, provider_message_id),
          CONSTRAINT uq_messages_company_client_request_id
            UNIQUE (company_id, client_request_id)
        );
      `);
      console.log('✅ Tabla messages creada o ya existe');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_occurred
        ON messages(conversation_id, occurred_at DESC);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_company_provider
        ON messages(company_id, channel, provider_message_id);
      `);

      // 5. Tabla de adjuntos
      await client.query(`
        CREATE TABLE IF NOT EXISTS message_attachments (
          id SERIAL PRIMARY KEY,
          message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          filename VARCHAR(255),
          mime_type VARCHAR(100),
          size_bytes INT,
          external_url TEXT,
          internal_path TEXT,
          metadata_json JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ Tabla message_attachments creada o ya existe');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_attachments_message_id
        ON message_attachments(message_id);
      `);

      // 6. Tabla de estados de mensaje
      await client.query(`
        CREATE TABLE IF NOT EXISTS message_statuses (
          id SERIAL PRIMARY KEY,
          message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          status VARCHAR(50) NOT NULL,
          source VARCHAR(50),
          occurred_at TIMESTAMPTZ DEFAULT NOW(),
          metadata_json JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ Tabla message_statuses creada o ya existe');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_statuses_message_id
        ON message_statuses(message_id);
      `);

      // 7. Tabla de auditoría
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
          company_id INT REFERENCES companies(id) ON DELETE SET NULL,
          actor VARCHAR(255),
          action VARCHAR(100) NOT NULL,
          entity_type VARCHAR(100),
          entity_id VARCHAR(255),
          metadata_json JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ Tabla audit_logs creada o ya existe');

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_audit_company_created
        ON audit_logs(company_id, created_at DESC);
      `);

      await client.query('COMMIT');
      console.log('✅ Operational Core DDL committed');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error en DDL del Operational Core:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const coreModel = new CoreModel(pool);
