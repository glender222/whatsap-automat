const express = require('express');
const AuthController = require('../controllers/authController');
const { validateJWT, requireAdmin } = require('../middleware/authMiddleware');

/**
 * @swagger
 * /auth/register:
 *   post:
 *     tags:
 *       - Autenticación
 *     summary: Registrar nuevo DUEÑO
 *     description: Solo los propietarios (DUEÑO) pueden registrarse. Este endpoint crea una nueva cuenta con rol ADMIN.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre:
 *                 type: string
 *                 example: "Juan Pérez"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "juan@empresa.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "MiPassword123!"
 *                 description: "Mínimo 6 caracteres"
 *     responses:
 *       200:
 *         description: Usuario registrado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *       400:
 *         description: Datos de entrada inválidos
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags:
 *       - Autenticación
 *     summary: Iniciar sesión
 *     description: Endpoint para login de DUEÑO o EMPLEADO. Devuelve JWT tokens.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "juan@empresa.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "MiPassword123!"
 *     responses:
 *       200:
 *         description: Login exitoso
 *       401:
 *         description: Email o contraseña incorrectos
 */

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     tags:
 *       - Autenticación
 *     summary: Refrescar Access Token
 *     description: Genera un nuevo Access Token usando el Refresh Token
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Token refrescado exitosamente
 *       401:
 *         description: Refresh token inválido o expirado
 */

/**
 * @swagger
 * /auth/me:
 *   get:
 *     tags:
 *       - Autenticación
 *     summary: Obtener información del usuario autenticado
 *     description: Devuelve los datos del usuario que está autenticado
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Información del usuario
 *       401:
 *         description: Token no proporcionado o inválido
 */

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     tags:
 *       - Autenticación
 *     summary: Cerrar sesión
 *     description: Revoca el refresh token y cierra la sesión
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Logout exitoso
 */

/**
 * @swagger
 * /auth/create-station:
 *   post:
 *     tags:
 *       - Estaciones de Trabajo
 *     summary: Crear estación de trabajo (ADMIN solo)
 *     description: Solo los DUEÑO (ADMIN) pueden crear empleados. Se genera automáticamente una contraseña temporal.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nombre:
 *                 type: string
 *                 example: "Carlos López"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "carlos@empresa.com"
 *     responses:
 *       200:
 *         description: Estación de trabajo creada exitosamente
 *       403:
 *         description: Solo administradores pueden crear estaciones
 */

/**
 * @swagger
 * /auth/employees:
 *   get:
 *     tags:
 *       - Estaciones de Trabajo
 *     summary: Obtener empleados del DUEÑO
 *     description: Lista todos los empleados creados por el DUEÑO autenticado
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de empleados
 *       403:
 *         description: Solo administradores pueden acceder
 */

function createAuthRoutes(whatsappService) {
  const router = express.Router();
  const authController = new AuthController(whatsappService);

  // ========================
  // JWT Routes (No requieren autenticación)
  // ========================
  
  router.post('/register', authController.register);
  router.post('/login', authController.login);

  // ========================
  // JWT Routes (Requieren autenticación)
  // ========================

  router.post('/refresh', validateJWT, authController.refresh);
  router.get('/me', validateJWT, authController.getMe);
  router.post('/logout', validateJWT, authController.logout);
  router.post('/create-station', validateJWT, requireAdmin, authController.createStation);
  router.get('/employees', validateJWT, requireAdmin, authController.getEmployees);
  router.put('/employees/:id', validateJWT, requireAdmin, authController.updateEmployee);
  router.delete('/employees/:id', validateJWT, requireAdmin, authController.deleteEmployee);

  // ========================
  // WhatsApp Routes (Legacy protegidas)
  // ========================

  router.get('/qr', validateJWT, authController.getQR);
  router.get('/status', validateJWT, authController.getStatus);
  router.post('/logout-whatsapp', validateJWT, authController.logoutWhatsapp);

  return router;
}

module.exports = createAuthRoutes;
