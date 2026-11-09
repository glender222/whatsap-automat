const { requireJwt, toPositiveInt } = require('./jwtAuth');

/**
 * Middleware para validar JWT token
 */
const validateJWT = (req, res, next) => requireJwt(req, res, () => {
  if (!toPositiveInt(req.user?.userId) || !req.whatsappCompanyId) {
    return res.status(403).json({ success: false, error: 'Sesión sin usuario o empresa válidos' });
  }
  return next();
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
