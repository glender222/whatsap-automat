const swaggerJsdoc = require('swagger-jsdoc');

const manualPaths: Record<string, any> = {
  '/company/me': {
    get: {
      tags: ['Empresa'],
      summary: 'Obtener info de la empresa actual',
      security: [{ BearerAuth: [] }],
      responses: { 200: { description: 'Datos de empresa, usuario y WhatsApp' }, 401: { description: 'No autorizado' } },
    },
  },
  '/company/whatsapp/connection': {
    get: {
      tags: ['Empresa'],
      summary: 'Estado de conexion WhatsApp',
      security: [{ BearerAuth: [] }],
      responses: { 200: { description: 'Estado de conexion' } },
    },
    post: {
      tags: ['Empresa'],
      summary: 'Conectar WhatsApp Business (solo ADMIN)',
      security: [{ BearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Conexion guardada' }, 403: { description: 'Solo admins' } },
    },
    delete: {
      tags: ['Empresa'],
      summary: 'Desconectar WhatsApp Business (solo ADMIN)',
      security: [{ BearerAuth: [] }],
      responses: { 200: { description: 'Desconectado' }, 403: { description: 'Solo admins' } },
    },
  },
  '/whatsapp/status': {
    get: { tags: ['WhatsApp'], summary: 'Estado del servicio WhatsApp', responses: { 200: { description: 'Estado' } } },
  },
  '/whatsapp/qr': {
    get: { tags: ['WhatsApp'], summary: 'Obtener QR de WhatsApp', responses: { 200: { description: 'QR code' } } },
  },
  '/whatsapp/me': {
    get: { tags: ['WhatsApp'], summary: 'Info del numero WhatsApp conectado', responses: { 200: { description: 'Info' }, 503: { description: 'No disponible' } } },
  },
  '/whatsapp/init': {
    post: { tags: ['WhatsApp'], summary: 'Inicializar servicio WhatsApp', responses: { 200: { description: 'Inicializado' } } },
  },
  '/whatsapp/logout': {
    post: { tags: ['WhatsApp'], summary: 'Cerrar sesion WhatsApp', responses: { 200: { description: 'Logout exitoso' } } },
  },
  '/whatsapp/chats': {
    get: {
      tags: ['WhatsApp'],
      summary: 'Listar chats',
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
      ],
      responses: { 200: { description: 'Lista de chats' } },
    },
  },
  '/whatsapp/messages/{chatId}': {
    get: {
      tags: ['WhatsApp'],
      summary: 'Obtener mensajes de un chat',
      parameters: [
        { name: 'chatId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        { name: 'before', in: 'query', schema: { type: 'integer', default: 0 } },
      ],
      responses: { 200: { description: 'Mensajes' } },
    },
  },
  '/whatsapp/templates': {
    get: {
      tags: ['WhatsApp'],
      summary: 'Listar templates de mensajes',
      parameters: [{ name: 'sync', in: 'query', schema: { type: 'boolean' } }],
      responses: { 200: { description: 'Templates' } },
    },
  },
  '/whatsapp/send-message': {
    post: {
      tags: ['WhatsApp'],
      summary: 'Enviar mensaje (texto, media o template)',
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                chatId: { type: 'string' },
                message: { type: 'string' },
                file: { type: 'string', format: 'binary' },
                templateName: { type: 'string' },
                templateLanguage: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Mensaje enviado' }, 400: { description: 'Faltan campos' } },
    },
  },
  '/agents': {
    get: { tags: ['Agentes IA'], summary: 'Listar agentes', security: [{ BearerAuth: [] }], responses: { 200: { description: 'Lista' } } },
    post: {
      tags: ['Agentes IA'], summary: 'Crear agente', security: [{ BearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Creado' } },
    },
  },
  '/agents/provider/status': {
    get: { tags: ['Agentes IA'], summary: 'Estado del proveedor IA', security: [{ BearerAuth: [] }], responses: { 200: { description: 'Estado' } } },
  },
  '/agents/provider/models': {
    get: { tags: ['Agentes IA'], summary: 'Modelos disponibles del proveedor', security: [{ BearerAuth: [] }], responses: { 200: { description: 'Modelos' } } },
  },
  '/agents/provider/test': {
    post: { tags: ['Agentes IA'], summary: 'Probar conexion con proveedor IA', security: [{ BearerAuth: [] }], responses: { 200: { description: 'Resultado' } } },
  },
  '/agents/suggest/default': {
    post: {
      tags: ['Agentes IA'], summary: 'Sugerir respuesta con agente por defecto', security: [{ BearerAuth: [] }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' }, history: { type: 'array', items: { type: 'object' } }, chatId: { type: 'string' } } } } } },
      responses: { 200: { description: 'Sugerencia' }, 404: { description: 'Sin agente activo' } },
    },
  },
  '/agents/runtime-logs': {
    get: {
      tags: ['Agentes IA'], summary: 'Logs de ejecucion de agentes', security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'chatId', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
      ],
      responses: { 200: { description: 'Logs' } },
    },
  },
  '/agents/{id}': {
    get: { tags: ['Agentes IA'], summary: 'Obtener agente por ID', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Agente' } } },
    put: { tags: ['Agentes IA'], summary: 'Actualizar agente', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Actualizado' } } },
    delete: { tags: ['Agentes IA'], summary: 'Archivar agente', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Archivado' } } },
  },
  '/agents/{id}/profile': {
    put: { tags: ['Agentes IA'], summary: 'Actualizar perfil del agente', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Perfil actualizado' } } },
  },
  '/agents/{id}/rules': {
    put: { tags: ['Agentes IA'], summary: 'Actualizar reglas del agente', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Reglas actualizadas' } } },
  },
  '/agents/{id}/knowledge': {
    post: { tags: ['Agentes IA'], summary: 'Agregar fuente de conocimiento', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],       responses: { 200: { description: 'Fuente creada' } } },
  },
  '/agents/{id}/knowledge/upload': {
    post: {
      tags: ['Agentes IA'], summary: 'Subir archivo como conocimiento', security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
      responses: { 200: { description: 'Archivo subido' }, 400: { description: 'Archivo requerido' } },
    },
  },
  '/agents/{id}/knowledge/{sourceId}': {
    put: { tags: ['Agentes IA'], summary: 'Actualizar fuente de conocimiento', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'sourceId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Actualizada' } } },
    delete: { tags: ['Agentes IA'], summary: 'Eliminar fuente de conocimiento', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'sourceId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Eliminada' } } },
  },
  '/agents/{id}/knowledge/{sourceId}/file': {
    get: { tags: ['Agentes IA'], summary: 'Descargar archivo de conocimiento', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'sourceId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Archivo' } } },
  },
  '/agents/{id}/test': {
    post: { tags: ['Agentes IA'], summary: 'Probar agente con mensaje', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Resultado' } } },
  },
  '/agents/{id}/suggest': {
    post: { tags: ['Agentes IA'], summary: 'Sugerir respuesta con agente especifico', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Sugerencia' } } },
  },
  '/tags': {
    get: { tags: ['Etiquetas'], summary: 'Listar etiquetas', security: [{ BearerAuth: [] }], responses: { 200: { description: 'Lista' } } },
    post: {
      tags: ['Etiquetas'], summary: 'Crear etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' } }, required: ['name'] } } } },
      responses: { 200: { description: 'Creada' }, 403: { description: 'Solo admins' }, 409: { description: 'Duplicada' } },
    },
  },
  '/tags/{id}': {
    get: { tags: ['Etiquetas'], summary: 'Obtener etiqueta', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Etiqueta' }, 404: { description: 'No encontrada' } } },
    put: { tags: ['Etiquetas'], summary: 'Actualizar etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Actualizada' }, 403: { description: 'Solo admins' } } },
    delete: { tags: ['Etiquetas'], summary: 'Eliminar etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Eliminada' }, 403: { description: 'Solo admins' } } },
  },
  '/tags/{id}/chats/full': {
    get: { tags: ['Etiquetas'], summary: 'Chats completos de una etiqueta', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Chats con detalles' } } },
  },
  '/tags/{id}/chats': {
    get: { tags: ['Etiquetas'], summary: 'IDs de chats de una etiqueta', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Lista de IDs' } } },
    post: { tags: ['Etiquetas'], summary: 'Asignar chat a etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { chatId: { type: 'string' } } } } } }, responses: { 200: { description: 'Asignado' } } },
  },
  '/tags/{id}/chats/{chatId}': {
    delete: { tags: ['Etiquetas'], summary: 'Remover chat de etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Removido' } } },
  },
  '/tags/{id}/users': {
    get: { tags: ['Etiquetas'], summary: 'Empleados asignados a etiqueta', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Empleados' } } },
    post: { tags: ['Etiquetas'], summary: 'Asignar empleado a etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { employeeId: { type: 'integer' } } } } } }, responses: { 200: { description: 'Asignado' } } },
  },
  '/tags/{id}/users/{employeeId}': {
    delete: { tags: ['Etiquetas'], summary: 'Revocar empleado de etiqueta (solo ADMIN)', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'employeeId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Revocado' } } },
  },
  '/tags/{id}/stats': {
    get: { tags: ['Etiquetas'], summary: 'Estadisticas de etiqueta', security: [{ BearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Stats' } } },
  },
  '/chats': {
    get: { tags: ['Chats'], summary: 'Listar chats (compat)', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }], responses: { 200: { description: 'Chats' } } },
  },
  '/chats/{chatId}/messages': {
    get: {
      tags: ['Chats'], summary: 'Mensajes de un chat',
      parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }],
      responses: { 200: { description: 'Mensajes' } },
    },
    post: {
      tags: ['Chats'], summary: 'Enviar mensaje a chat',
      parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { message: { type: 'string' }, file: { type: 'string', format: 'binary' }, templateName: { type: 'string' } } } } } },
      responses: { 200: { description: 'Enviado' }, 400: { description: 'Faltan campos' } },
    },
  },
  '/chats/{chatId}/session/status': {
    get: { tags: ['Chats'], summary: 'Estado de sesion del chat', parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Estado' } } },
  },
  '/chats/{chatId}/sessions/complete': {
    post: { tags: ['Chats'], summary: 'Completar sesion de servicio', parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Sesion finalizada' } } },
  },
  '/chats/{chatId}/read': {
    post: { tags: ['Chats'], summary: 'Marcar chat como leido (POST)', parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Leido' } } },
    put: { tags: ['Chats'], summary: 'Marcar chat como leido (PUT)', parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Leido' } } },
  },
  '/customer-history/contacts/{contactId}': {
    get: {
      tags: ['Historial Cliente'], summary: 'Historial por contacto', security: [{ BearerAuth: [] }],
      parameters: [{ name: 'contactId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'conversationLimit', in: 'query', schema: { type: 'integer' } }, { name: 'messageLimit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'Historial' }, 404: { description: 'No encontrado' } },
    },
  },
  '/customer-history/chats/{chatId}': {
    get: {
      tags: ['Historial Cliente'], summary: 'Historial por chat', security: [{ BearerAuth: [] }],
      parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'conversationLimit', in: 'query', schema: { type: 'integer' } }, { name: 'messageLimit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'Historial' }, 404: { description: 'No encontrado' } },
    },
  },
  '/webhooks/meta/whatsapp': {
    get: {
      tags: ['Webhooks Meta'], summary: 'Verificacion de webhook Meta',
      parameters: [{ name: 'hub.mode', in: 'query', schema: { type: 'string' } }, { name: 'hub.verify_token', in: 'query', schema: { type: 'string' } }, { name: 'hub.challenge', in: 'query', schema: { type: 'string' } }],
      responses: { 200: { description: 'Challenge devuelto' }, 403: { description: 'Token invalido' } },
    },
    post: {
      tags: ['Webhooks Meta'], summary: 'Recibir eventos de Meta WhatsApp',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Procesado' }, 403: { description: 'Firma invalida' } },
    },
  },
  '/media/{messageId}': {
    get: { tags: ['Media'], summary: 'Descargar media de mensaje', parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Archivo media' } } },
  },
  '/media/{messageId}/info': {
    get: { tags: ['Media'], summary: 'Info de media', parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Info' } } },
  },
  '/media/{messageId}/thumbnail': {
    get: { tags: ['Media'], summary: 'Thumbnail de media', parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Thumbnail' } } },
  },
};

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'WhatsApp Empresas API',
      version: '2.0.0',
      description: 'API completa de autenticacion, gestion empresarial, WhatsApp, agentes IA, etiquetas y media',
      contact: { name: 'API Support', url: 'http://localhost:3000' },
    },
    servers: [
      { url: 'http://localhost:3000/api', description: 'Desarrollo local' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT Access Token',
        },
      },
    },
    paths: manualPaths,
    tags: [
      { name: 'Autenticación', description: 'Registro, login, JWT y gestion de empleados' },
      { name: 'Empresa', description: 'Datos de empresa y conexion WhatsApp Business' },
      { name: 'WhatsApp', description: 'Servicio WhatsApp: estado, chats, mensajes y templates' },
      { name: 'Agentes IA', description: 'CRUD de agentes, conocimiento, pruebas y sugerencias' },
      { name: 'Etiquetas', description: 'Gestion de etiquetas, asignacion de chats y empleados' },
      { name: 'Chats', description: 'API compatible: chats, mensajes, sesiones' },
      { name: 'Historial Cliente', description: 'Historial de conversaciones por contacto o chat' },
      { name: 'Webhooks Meta', description: 'Verificacion y recepcion de webhooks de Meta' },
      { name: 'Media', description: 'Descarga e info de archivos multimedia' },
      { name: 'Estaciones de Trabajo', description: 'Gestion de empleados/estaciones' },
    ],
  },
  apis: ['./src/routes/authRoutes.js'],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
module.exports = swaggerSpec;
