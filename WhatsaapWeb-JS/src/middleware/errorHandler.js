/**
 * Middleware para manejo de errores
 */
function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  if (err.statusCode || err.status) {
    return res.status(err.statusCode || err.status).json({
      success: false,
      error: err.code || 'REQUEST_FAILED',
      message: err.message,
      userMessage: err.userMessage,
      action: err.action,
      providerStatusCode: err.providerStatusCode,
      details: process.env.NODE_ENV === 'development' ? err.meta || err.stack : undefined
    });
  }

  // Error de validación
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Datos de entrada inválidos',
      details: err.message
    });
  }

  // Error de WhatsApp no conectado
  if (err.message.includes('not connected') || err.message.includes('DISCONNECTED')) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp no está conectado',
      details: 'Por favor, escanea el código QR para conectar'
    });
  }

  // Error de chat no encontrado
  if (err.message.includes('Chat not found')) {
    return res.status(404).json({
      success: false,
      error: 'Chat no encontrado',
      details: err.message
    });
  }

  // Error de autenticación
  if (err.message.includes('Usuario no encontrado') || err.message.includes('Contraseña incorrecta') || err.message.includes('no tiene contraseña configurada')) {
    return res.status(401).json({
      success: false,
      error: 'AUTHENTICATION_FAILED',
      message: 'Email o contraseña incorrectos',
      details: err.message
    });
  }

  // Error genérico del servidor
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Contacta al administrador'
  });
}

/**
 * Middleware para rutas no encontradas
 */
function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: 'Endpoint no encontrado',
    details: `La ruta ${req.method} ${req.path} no existe`
  });
}

/**
 * Wrapper para funciones async en controladores
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandler,
  notFound,
  asyncHandler
};
