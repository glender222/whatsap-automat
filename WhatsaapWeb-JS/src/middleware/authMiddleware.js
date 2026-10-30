const { asyncHandler } = require('./errorHandler');
const { extractTokenFromHeader, verifyToken } = require('../utils/jwt');

/**
 * Middleware para validar JWT token
 */
const validateJWT = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Token no proporcionado',
      details: 'Se requiere un token Bearer en el header Authorization'
    });
  }

  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({
      success: false,
      error: 'Token inválido o expirado',
      details: 'El token no es válido o ha expirado'
    });
  }

  // Agregar payload al request
  req.user = payload;
  next();
});

/**
 * Middleware para validar que el usuario sea ADMIN (DUEÑO)
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'No autenticado',
      details: 'Debes estar autenticado'
    });
  }

  if (req.user.rol !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: 'No autorizado',
      details: 'Solo administradores pueden acceder a este recurso'
    });
  }

  next();
};

/**
 * Middleware para validar que el usuario sea EMPLEADO
 */
const requireEmployee = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'No autenticado',
      details: 'Debes estar autenticado'
    });
  }

  if (req.user.rol !== 'EMPLEADO') {
    return res.status(403).json({
      success: false,
      error: 'No autorizado',
      details: 'Solo empleados pueden acceder a este recurso'
    });
  }

  next();
};

module.exports = {
  validateJWT,
  requireAdmin,
  requireEmployee
};