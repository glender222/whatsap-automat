const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

/**
 * Hashea una contraseña
 * @param {string} password - Contraseña en texto plano
 * @returns {Promise<string>} - Contraseña hasheada
 */
async function hashPassword(password) {
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    return hash;
  } catch (error) {
    console.error('Error hasheando contraseña:', error);
    throw error;
  }
}

/**
 * Compara una contraseña con su hash
 * @param {string} password - Contraseña en texto plano
 * @param {string} hash - Hash guardado
 * @returns {Promise<boolean>} - true si coinciden, false si no
 */
async function comparePassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch (error) {
    console.error('Error comparando contraseña:', error);
    throw error;
  }
}

/**
 * Genera una contraseña aleatoria de 12 caracteres
 * @returns {string} - Contraseña aleatoria
 */
function generateRandomPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

module.exports = {
  hashPassword,
  comparePassword,
  generateRandomPassword
};