const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'WhatsApp Empresas API',
      version: '1.0.0',
      description: 'API de autenticación y gestión de WhatsApp para empresas',
      contact: {
        name: 'API Support',
        url: 'http://localhost:3000'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000/api',
        description: 'API de desarrollo'
      }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT Access Token'
        }
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              example: 1
            },
            nombre: {
              type: 'string',
              example: 'Juan Pérez'
            },
            email: {
              type: 'string',
              example: 'juan@empresa.com'
            },
            rol: {
              type: 'string',
              enum: ['ADMIN', 'EMPLEADO'],
              example: 'ADMIN'
            },
            id_padre: {
              type: 'integer',
              nullable: true,
              example: null
            },
            activo: {
              type: 'boolean',
              example: true
            },
            fecha_creacion: {
              type: 'string',
              format: 'date-time',
              example: '2024-10-17T00:23:52.000Z'
            }
          }
        },
        AuthResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            message: {
              type: 'string',
              example: 'Login exitoso'
            },
            data: {
              type: 'object',
              properties: {
                user: {
                  $ref: '#/components/schemas/User'
                },
                accessToken: {
                  type: 'string',
                  example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
                },
                refreshToken: {
                  type: 'string',
                  example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
                }
              }
            }
          }
        },
        StationResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            message: {
              type: 'string',
              example: 'Estación de trabajo creada exitosamente'
            },
            data: {
              type: 'object',
              properties: {
                employee: {
                  $ref: '#/components/schemas/User'
                },
                tempPassword: {
                  type: 'string',
                  example: 'aBc123!@#Xyz'
                }
              }
            }
          }
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false
            },
            error: {
              type: 'string',
              example: 'Error message'
            },
            details: {
              type: 'string',
              example: 'Additional error details'
            }
          }
        }
      }
    }
  },
  apis: [
    './src/routes/authRoutes.js'
  ]
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;