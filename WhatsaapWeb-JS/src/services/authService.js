const User = require('../models/User');
const pool = require('../config/database');
const { toPositiveInt } = require('../middleware/jwtAuth');
const { withTenantTransaction } = require('../db/TenantScopedUoW');
const { PgUnitOfWork } = require('../shared/PgUnitOfWork');
const { hashPassword, comparePassword, generateRandomPassword } = require('../utils/password');
const { generateAccessToken, generateRefreshToken, verifyToken } = require('../utils/jwt');

const provisioning = new PgUnitOfWork(pool);

function authError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function accessClaims(user) {
  const companyId = toPositiveInt(user.company_id);
  if (!companyId) throw authError('La cuenta no tiene una empresa asignada', 403);
  return {
    userId: user.id,
    email: user.email,
    nombre: user.nombre,
    rol: user.rol,
    idPadre: user.id_padre,
    companyId,
  };
}

async function issueSession(user, client) {
  const { userId, ...profile } = accessClaims(user);
  const accessToken = generateAccessToken({ userId, ...profile });
  const refreshToken = generateRefreshToken({ userId, email: profile.email });
  await User.saveRefreshToken(userId, refreshToken, 30 * 24 * 60 * 60 * 1000, client);
  return { user: { id: userId, ...profile }, accessToken, refreshToken };
}

class AuthService {
  static async register(nombre, email, password) {
    if (typeof nombre !== 'string' || !nombre.trim() ||
        typeof email !== 'string' || !email.trim() ||
        typeof password !== 'string' || password.length < 6) {
      throw authError('Ingresa nombre, correo y una contraseña de al menos 6 caracteres', 400);
    }

    const name = nombre.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (name.length > 100 || normalizedEmail.length > 100) {
      throw authError('Nombre o correo demasiado largo', 400);
    }

    const passwordHash = await hashPassword(password);
    return provisioning.transaction(async ({ client }) => {
      const { rows: [company] } = await client.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(company.id)]);
      await client.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [company.id, name, `company-${company.id}`]);
      await client.query(
        "INSERT INTO workspaces (tenant_id, name, slug, is_default) VALUES ($1, 'Principal', 'default', true)",
        [company.id]
      );
      const user = await User.create(name, normalizedEmail, passwordHash, 'ADMIN', null, company.id, client);
      await client.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [company.id, user.id]);
      return issueSession(user, client);
    });
  }

  static async login(email, password) {
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      throw authError('Email y contraseña son requeridos', 400);
    }

    const address = email.trim();
    const normalized = address.toLowerCase();
    const user = await User.findByEmail(normalized) || (address !== normalized && await User.findByEmail(address));
    if (!user?.password_hash || !await comparePassword(password, user.password_hash)) {
      throw authError('Correo o contraseña incorrectos', 401);
    }
    return issueSession(user);
  }

  static async refreshAccessToken(refreshToken) {
    const payload = typeof refreshToken === 'string' ? verifyToken(refreshToken) : null;
    if (!payload?.userId || typeof payload.email !== 'string' ||
        !await User.verifyRefreshToken(payload.userId, refreshToken)) {
      throw authError('Refresh token inválido o expirado', 401);
    }

    const user = await User.findByEmail(payload.email);
    if (!user || String(user.id) !== String(payload.userId)) {
      throw authError('Refresh token inválido o expirado', 401);
    }
    return { accessToken: generateAccessToken(accessClaims(user)) };
  }

  static async createStation(ownerId, nombre, email, password, companyId) {
    if (typeof nombre !== 'string' || !nombre.trim() || typeof email !== 'string' || !email.trim()) {
      throw authError('Nombre y email son requeridos', 400);
    }
    if (password && (typeof password !== 'string' || password.length < 6)) {
      throw authError('La contraseña debe tener al menos 6 caracteres', 400);
    }

    const tempPassword = password || generateRandomPassword();
    const passwordHash = await hashPassword(tempPassword);
    const employee = await withTenantTransaction(companyId, async (client) => {
      const { rows } = await client.query("SELECT id FROM usuarios WHERE id = $1 AND activo = true AND rol = 'ADMIN'", [ownerId]);
      if (rows.length === 0) throw authError('No autorizado para crear estaciones', 403);
      const user = await User.create(nombre.trim(), email.trim().toLowerCase(), passwordHash, 'EMPLEADO', ownerId, companyId, client);
      await client.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [companyId, user.id]);
      return user;
    });
    return {
      employee: {
        id: employee.id,
        nombre: employee.nombre,
        email: employee.email,
        rol: employee.rol,
        companyId: employee.company_id,
      },
      tempPassword,
    };
  }

  /**
   * Actualizar estación de trabajo del administrador autenticado
   */
  static async updateEmployee(ownerId, employeeId, data, companyId) {
    const employee = await User.findEmployeeByOwner(ownerId, employeeId, companyId);
    if (!employee) {
      throw new Error('Estación no encontrada o no pertenece al administrador');
    }

    const updates = {};

    if (typeof data.nombre === 'string') {
      const nombre = data.nombre.trim();
      if (!nombre) throw new Error('Nombre requerido');
      updates.nombre = nombre;
    }

    if (typeof data.email === 'string') {
      const email = data.email.trim().toLowerCase();
      if (!email) throw new Error('Email requerido');
      updates.email = email;
    }

    if (typeof data.password === 'string' && data.password.length > 0) {
      if (data.password.length < 6) {
        throw new Error('La contraseña debe tener al menos 6 caracteres');
      }
      updates.password_hash = await hashPassword(data.password);
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No hay datos para actualizar');
    }

    return User.updateEmployeeForOwner(ownerId, employeeId, updates, companyId);
  }

  /**
   * Desactivar estación de trabajo del administrador autenticado
   */
  static async deactivateEmployee(ownerId, employeeId, companyId) {
    const employee = await User.findEmployeeByOwner(ownerId, employeeId, companyId);
    if (!employee) {
      throw new Error('Estación no encontrada o no pertenece al administrador');
    }

    return User.deactivateEmployeeForOwner(ownerId, employeeId, companyId);
  }

  /**
   * Logout
   */
  static async logout(userId, refreshToken) {
    if (refreshToken) {
      await User.revokeRefreshToken(userId, refreshToken);
    }
    return true;
  }
}

module.exports = AuthService;
