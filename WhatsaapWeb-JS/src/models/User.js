const pool = require('../config/database');
const { createHash } = require('node:crypto');
const { withTenantTransaction } = require('../db/TenantScopedUoW');
const { PgUnitOfWork } = require('../shared/PgUnitOfWork');

const authLookup = new PgUnitOfWork(pool);

function digestRefreshToken(token) {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

class User {
  /**
   * Crear tipo ENUM y tablas de usuarios
   */
  static async createTableIfNotExists() {
    try {
      // PASO 1: Crear el tipo ENUM si no existe
      const enumQuery = `
        DO $$ BEGIN
          CREATE TYPE rol_enum AS ENUM('ADMIN', 'EMPLEADO');
        EXCEPTION WHEN duplicate_object THEN null;
        END $$;
      `;
      
      await pool.query(enumQuery);
      console.log('✅ Tipo ENUM creado o ya existe');

      // PASO 2: Crear tabla usuarios
      const usuariosQuery = `
        CREATE TABLE IF NOT EXISTS usuarios (
          id BIGSERIAL PRIMARY KEY,
          nombre VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          rol rol_enum NOT NULL DEFAULT 'EMPLEADO',
          id_padre BIGINT REFERENCES usuarios(id) ON DELETE CASCADE,
          company_id INT REFERENCES companies(id) ON DELETE SET NULL,
          activo BOOLEAN DEFAULT true,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;
      
      await pool.query(usuariosQuery);
      console.log('✅ Tabla usuarios creada correctamente');

      // PASO 3: Crear índices
      const indexQuery = `
        ALTER TABLE usuarios
          ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;

        UPDATE usuarios
        SET company_id = COALESCE(company_id, 1)
        WHERE company_id IS NULL;

        CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
        CREATE INDEX IF NOT EXISTS idx_usuarios_id_padre ON usuarios(id_padre);
        CREATE INDEX IF NOT EXISTS idx_usuarios_company_id ON usuarios(company_id);
      `;
      
      await pool.query(indexQuery);
      console.log('✅ Índices creados correctamente');

      // PASO 4: Crear tabla refresh_tokens
      const refreshTokensQuery = `
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id BIGSERIAL PRIMARY KEY,
          usuario_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
          token TEXT NOT NULL UNIQUE,
          expira_en TIMESTAMP NOT NULL,
          creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          revocado BOOLEAN DEFAULT false
        );
      `;
      
      await pool.query(refreshTokensQuery);
      console.log('✅ Tabla refresh_tokens creada correctamente');

      // PASO 5: Crear índice para refresh_tokens
      const rtIndexQuery = `
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario_id ON refresh_tokens(usuario_id);
      `;
      
      await pool.query(rtIndexQuery);
      console.log('✅ Índices de refresh_tokens creados correctamente');

      console.log('✅ Base de datos inicializada correctamente');
      
    } catch (error) {
      console.error('❌ Error creando tablas:', error.message);
      throw error;
    }
  }

  /**
   * Crear un nuevo usuario
   */
  static async create(nombre, email, passwordHash, rol, idPadre, companyId, client) {
    const query = `
      INSERT INTO usuarios (nombre, email, password_hash, rol, id_padre, company_id, activo)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING id, nombre, email, rol, id_padre, company_id, activo, fecha_creacion
    `;
    
    try {
      const result = await client.query(query, [nombre, email, passwordHash, rol, idPadre, companyId]);
      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') { // Unique violation
        const err = new Error('El email ya está registrado');
        err.statusCode = 409;
        throw err;
      }
      throw error;
    }
  }

  /**
   * Buscar usuario por email
   */
  static async findByEmail(email) {
    const query = `
      SELECT id, nombre, email, password_hash, rol, id_padre, company_id, activo, fecha_creacion
      FROM usuarios
      WHERE email = $1 AND activo = true
    `;
    
    return authLookup.transaction(async ({ client }) => {
      await client.query("SELECT set_config('app.login_email', $1, true)", [email]);
      const result = await client.query(query, [email]);
      return result.rows[0] || null;
    });
  }

  static async lockSessionUser(companyId, userId, client) {
    const { rows: [user] } = await client.query(
      `SELECT id, email, nombre, password_hash, rol, id_padre, company_id FROM usuarios
       WHERE company_id = $1 AND id = $2 AND activo = true FOR SHARE`,
      [companyId, userId],
    );
    return user || null;
  }

  /**
   * Buscar usuario por ID
   */
  static async findById(id, companyId) {
    const query = `
      SELECT id, nombre, email, rol, id_padre, company_id, activo, fecha_creacion
      FROM usuarios
      WHERE id = $1 AND activo = true
    `;
    
    const result = await withTenantTransaction(companyId, (client) => client.query(query, [id]));
    return result.rows[0] || null;
  }

  /**
   * Obtener todos los empleados de un dueño
   */
  static async findEmployeesByOwner(ownerId, companyId) {
    const query = `
      SELECT id, nombre, email, rol, id_padre, company_id, activo, fecha_creacion
      FROM usuarios
      WHERE id_padre = $1 AND activo = true
    `;
    
    const result = await withTenantTransaction(companyId, (client) => client.query(query, [ownerId]));
    return result.rows;
  }

  /**
   * Guardar refresh token
   */
  static async saveRefreshToken(usuarioId, token, expiresIn, db) {
    const expiresAt = new Date(Date.now() + expiresIn);
    const query = `
      INSERT INTO refresh_tokens (usuario_id, token, expira_en)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    
    const result = await db.query(query, [usuarioId, digestRefreshToken(token), expiresAt]);
    return result.rows[0];
  }

  /**
   * Verificar si refresh token existe y es válido
   */
  static async findActiveRefreshToken(usuarioId, token, db) {
    const query = `
      SELECT id FROM refresh_tokens
      WHERE usuario_id = $1 AND token = $2 AND revocado = false AND expira_en > clock_timestamp()
      FOR SHARE
    `;
    
    const result = await db.query(query, [usuarioId, digestRefreshToken(token)]);
    return result.rows[0] || null;
  }

  /**
   * Revocar refresh token
   */
  static async revokeRefreshToken(usuarioId, token, db) {
    const query = `
      UPDATE refresh_tokens
      SET revocado = true
      WHERE token = $1 AND usuario_id = $2
    `;
    
    await db.query(query, [digestRefreshToken(token), usuarioId]);
  }

  static async revokeAccessSession(userId, sessionId, client) {
    await client.query(
      'UPDATE refresh_tokens SET revocado = true WHERE usuario_id = $1 AND id = $2',
      [userId, sessionId],
    );
  }

  static async revokeUserSessions(userId, client) {
    await client.query(
      'UPDATE refresh_tokens SET revocado = true WHERE usuario_id = $1 AND revocado = false',
      [userId],
    );
  }

  /**
   * Actualizar un empleado validando pertenencia al dueño
   */
  static async updateEmployeeForOwner(ownerId, employeeId, data, companyId) {
    const allowedFields = ['nombre', 'email', 'password_hash'];
    const fields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(data)) {
      if (!allowedFields.includes(key)) continue;
      fields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }

    if (fields.length === 0) {
      throw new Error('No hay campos validos para actualizar');
    }

    fields.push('fecha_actualizacion = CURRENT_TIMESTAMP');
    values.push(employeeId, ownerId, companyId);

    const query = `
      WITH prior AS (
        SELECT id, email FROM usuarios
        WHERE id = $${paramCount} AND id_padre = $${paramCount + 1} AND company_id = $${paramCount + 2}
          AND rol = 'EMPLEADO' AND activo = true FOR UPDATE
      )
      UPDATE usuarios AS employee
      SET ${fields.join(', ')}
      FROM prior
      WHERE employee.id = prior.id
      RETURNING employee.id, employee.nombre, employee.email, employee.rol, employee.id_padre,
        employee.company_id, employee.activo, employee.fecha_creacion, employee.fecha_actualizacion,
        prior.email AS previous_email
    `;

    try {
      return await withTenantTransaction(companyId, async (client) => {
        const { rows: [updated] } = await client.query(query, values);
        if (!updated) return null;
        const { previous_email, ...employee } = updated;
        if (Object.hasOwn(data, 'password_hash') || previous_email !== employee.email) {
          await User.revokeUserSessions(employee.id, client);
        }
        return employee;
      });
    } catch (error) {
      if (error.code === '23505') {
        const err = new Error('El email ya está registrado');
        err.statusCode = 409;
        throw err;
      }
      throw error;
    }
  }

  /**
   * Desactivar un empleado validando pertenencia al dueño
   */
  static async deactivateEmployeeForOwner(ownerId, employeeId, companyId) {
    const query = `
      UPDATE usuarios
      SET activo = false, fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id = $1
        AND id_padre = $2
        AND company_id = $3
        AND rol = 'EMPLEADO'
        AND activo = true
      RETURNING id, nombre, email, activo
    `;

    return withTenantTransaction(companyId, async (client) => {
      const { rows: [employee] } = await client.query(query, [employeeId, ownerId, companyId]);
      if (!employee) return null;
      await User.revokeUserSessions(employee.id, client);
      return employee;
    });
  }
}

module.exports = User;
