const User = require('../models/User');
const { hashPassword, comparePassword, generateRandomPassword } = require('../utils/password');
const { generateAccessToken, generateRefreshToken } = require('../utils/jwt');

class AuthService {
  /**
   * Registrar un nuevo DUEÑO
   */
  static async register(nombre, email, password) {
    // Validar entrada
    if (!nombre || !email || !password) {
      throw new Error('Nombre, email y contraseña son requeridos');
    }

    if (password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres');
    }

    // Hashear contraseña
    const passwordHash = await hashPassword(password);

    // Crear usuario con rol ADMIN
    const user = await User.create(nombre, email, passwordHash, 'ADMIN', null);

    // Generar tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      idPadre: user.id_padre,
      companyId: user.company_id || 1
    });

    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email
    });

    // Guardar refresh token en BD
    await User.saveRefreshToken(user.id, refreshToken, 30 * 24 * 60 * 60 * 1000); // 30 días

    return {
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        companyId: user.company_id || 1
      },
      accessToken,
      refreshToken
    };
  }

  /**
   * Login de usuario
   */
  static async login(email, password) {
    // Validar entrada
    if (!email || !password) {
      throw new Error('Email y contraseña son requeridos');
    }

    // Buscar usuario
    const user = await User.findByEmail(email);
    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    // Comparar contraseña
    if (!user.password_hash) {
      throw new Error('Usuario no tiene contraseña configurada');
    }
    const isValidPassword = await comparePassword(password, user.password_hash);
    if (!isValidPassword) {
      throw new Error('Contraseña incorrecta');
    }

    // Generar tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      idPadre: user.id_padre,
      companyId: user.company_id || 1
    });

    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email
    });

    // Guardar refresh token en BD
    await User.saveRefreshToken(user.id, refreshToken, 30 * 24 * 60 * 60 * 1000); // 30 días

    return {
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        idPadre: user.id_padre,
        companyId: user.company_id || 1
      },
      accessToken,
      refreshToken
    };
  }

  /**
   * Refrescar access token
   */
  static async refreshAccessToken(refreshToken, userId) {
    // Validar que el refresh token existe en BD
    const isValid = await User.verifyRefreshToken(userId, refreshToken);
    if (!isValid) {
      throw new Error('Refresh token inválido o expirado');
    }

    // Obtener datos del usuario
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    // Generar nuevo access token
    const newAccessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      idPadre: user.id_padre,
      companyId: user.company_id || 1
    });

    return {
      accessToken: newAccessToken
    };
  }

  /**
   * Crear estación de trabajo (empleado)
   */
  static async createStation(ownerId, nombre, email, password = null) {
    // Validar entrada
    if (!nombre || !email) {
      throw new Error('Nombre y email son requeridos');
    }

    if (password && password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres');
    }

    const tempPassword = password || generateRandomPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Crear empleado
    const employee = await User.create(nombre, email, passwordHash, 'EMPLEADO', ownerId);

    return {
      employee: {
        id: employee.id,
        nombre: employee.nombre,
        email: employee.email,
        rol: employee.rol,
        companyId: employee.company_id || 1
      },
      tempPassword // Mostrar solo una vez
    };
  }

  /**
   * Actualizar estación de trabajo del administrador autenticado
   */
  static async updateEmployee(ownerId, employeeId, data = {}) {
    const employee = await User.findEmployeeByOwner(ownerId, employeeId);
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

    return User.updateEmployeeForOwner(ownerId, employeeId, updates);
  }

  /**
   * Desactivar estación de trabajo del administrador autenticado
   */
  static async deactivateEmployee(ownerId, employeeId) {
    const employee = await User.findEmployeeByOwner(ownerId, employeeId);
    if (!employee) {
      throw new Error('Estación no encontrada o no pertenece al administrador');
    }

    return User.deactivateEmployeeForOwner(ownerId, employeeId);
  }

  /**
   * Logout
   */
  static async logout(refreshToken) {
    if (refreshToken) {
      await User.revokeRefreshToken(refreshToken);
    }
    return true;
  }
}

module.exports = AuthService;
