const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const config = require('../config');

const JWT_SECRET = config.jwt.secret;
const JWT_ACCESS_EXPIRY = config.jwt.accessExpiry;
const JWT_REFRESH_EXPIRY = config.jwt.refreshExpiry;

/**
 * Genera un JWT token de acceso
 * @param {Object} payload - Datos a incluir en el token
 * @returns {string} - Token JWT
 */
function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRY,
    algorithm: 'HS256'
  });
}

/**
 * Genera un JWT token de refresco
 * @param {Object} payload - Datos a incluir en el token
 * @returns {string} - Token JWT
 */
function generateRefreshToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRY,
    jwtid: randomUUID(),
    algorithm: 'HS256'
  });
}

/**
 * Verifica un JWT token
 * @param {string} token - Token a verificar
 * @returns {Object|null} - Payload si es válido, null si no
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    console.error('Error verificando token:', error.message);
    return null;
  }
}

/**
 * Extrae el token del header Authorization
 * @param {string} authHeader - Header Authorization
 * @returns {string|null} - Token o null
 */
function extractTokenFromHeader(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  extractTokenFromHeader
};
