const { asyncHandler } = require('../middleware/errorHandler');
const User = require('../models/User');
const AuthService = require('../services/authService');

class UserController {
  /**
   * GET /api/auth/me - Obtener información del usuario autenticado
   */
  getMe = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }

    res.json({
      success: true,
      data: user
    });
  });

  /**
   * GET /api/auth/employees - Obtener empleados del dueño
   */
  getEmployees = asyncHandler(async (req, res) => {
    // Solo ADMIN puede ver sus empleados
    if (req.user.rol !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Solo administradores pueden acceder'
      });
    }

    const employees = await User.findEmployeesByOwner(req.user.userId);

    res.json({
      success: true,
      data: employees
    });
  });
}

module.exports = UserController;