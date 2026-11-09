import express, { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import helmet from 'helmet';
import WhatsAppService from './services/whatsappService';
import createWhatsAppRoutes from './routes/whatsappRoutes';
import createMetaWebhookRoutes from './routes/metaWebhookRoutes';
import createChatCompatRoutes from './routes/chatCompatRoutes';
import createCompanyRoutes from './routes/companyRoutes';
import createAgentRoutes from './routes/agentRoutes';
import createCatalogRoutes from './routes/catalogRoutes';
import createTagRoutes from './routes/tagRoutes';
import createCustomerHistoryRoutes from './routes/customerHistoryRoutes';
import createReportRoutes from './routes/reportRoutes';
import createProductRoutes from './routes/productRoutes';
import createOrderRoutes from './routes/orderRoutes';
import createDashboardRoutes from './routes/dashboardRoutes';
import createPaymentRoutes from './routes/paymentRoutes';
import createIaPauseRoutes from './routes/iaPauseRoutes';
import createPaymentWebhookRoutes from './routes/paymentWebhookRoutes';
import createConversationRoutes from './routes/conversationRoutes';
import createWorkflowRoutes from './routes/workflowRoutes';
import createAiRoutes from './routes/ai.routes';
import createAdminRoutes from './routes/adminRoutes';
import { createCampaignRoutes, createConsentRoutes, createSegmentRoutes } from './routes/campaigns.routes';
import createOpenApiRoutes from './routes/openapiRoutes';
import { createMarketplaceRoutes } from './routes/marketplaceRoutes';
import { optionalWhatsappJwt, requireJwt } from './middleware/jwtAuth';
import { requireChatTenantAccess, requireMediaTenantAccess, requireVoucherTenantAccess } from './middleware/resourceAuth';
import { coreModel } from './core/coreModel';
import config from './config/index';
import swaggerSpec from './config/swagger';
import { setSocketIo } from './sockets/socketEmitter';

import { SocketHandler } from './sockets/socketHandler';

const swaggerUi = require('swagger-ui-express');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const User = require('./models/User');
const createAuthRoutes = require('./routes/authRoutes');
const createChatRoutes = require('./routes/chatRoutes');
const createMediaRoutes = require('./routes/mediaRoutes');

type RawBodyRequest = Request & { rawBody?: Buffer };
type RateLimitEntry = { count: number; resetAt: number };

export class App {
  readonly app: Express;
  private readonly server: http.Server;
  private readonly io: Server;
  private readonly whatsappService: WhatsAppService;
  private readonly socketHandler: SocketHandler;
  private conversationCore: any;

  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server, {
      cors: { origin: config.cors.origin },
    });

    this.whatsappService = new WhatsAppService();
    this.socketHandler = new SocketHandler(this.whatsappService);

    this.setupMiddleware();
    this.setupSwagger();
    this.setupProcessHandlers();
  }

  private setupMiddleware(): void {
    this.app.use(
      helmet({
        crossOriginResourcePolicy: false,
        crossOriginEmbedderPolicy: false,
      })
    );

    this.app.use(cors(config.cors));
    this.app.use(
      '/uploads/commercial-items',
      express.static(path.join(config.whatsapp.uploadDir, 'commercial-items'), {
        fallthrough: false,
        maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
      })
    );
    // SEC-06: Storage scoped y autenticado para comprobantes de pago sensibles
    this.app.get(
      '/uploads/payment-vouchers/:filename',
      requireJwt as any,
      requireVoucherTenantAccess as any,
      (req: Request, res: Response) => {
        const filename = path.basename(String(req.params.filename || ''));
        const filePath = path.join(config.whatsapp.uploadDir, 'payment-vouchers', filename);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({
            success: false,
            error: 'VOUCHER_NOT_FOUND',
            message: 'Comprobante de pago no encontrado',
          });
        }
        return res.sendFile(path.resolve(filePath));
      }
    );
    this.app.use(express.json({
      verify: (req: RawBodyRequest, _res, buf) => {
        req.rawBody = buf;
      },
    }));
    this.app.use(express.urlencoded({ extended: true }));

    this.app.use('/api', this.createApiRateLimiter());
  }

  private createApiRateLimiter(): (req: Request, res: Response, next: NextFunction) => void {
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10);
    const defaultMaxRequests = process.env.NODE_ENV === 'production' ? '300' : '1500';
    const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || defaultMaxRequests, 10);
    const hits = new Map<string, RateLimitEntry>();
    const readHeavyRoutes = [
      /^\/v1\/openapi(?:\.(?:json|yaml))?$/,
      /^\/v1\/docs(?:\/.*)?$/,
      /^\/agents(?:\/.*)?$/,
      /^\/catalogs(?:\/.*)?$/,
      /^\/chats\/[^/]+\/messages(?:\/.*)?$/,
      /^\/chats\/[^/]+\/session\/status$/,
      /^\/company\/me$/,
      /^\/company\/whatsapp\/connection$/,
      /^\/commercial-items(?:\/.*)?$/,
      /^\/customer-history(?:\/.*)?$/,
      /^\/dashboard(?:\/.*)?$/,
      /^\/orders(?:\/.*)?$/,
      /^\/payments(?:\/.*)?$/,
      /^\/products(?:\/.*)?$/,
      /^\/reports(?:\/.*)?$/,
      /^\/tags(?:\/.*)?$/,
      /^\/whatsapp\/templates$/,
    ];

    return (req: Request, res: Response, next: NextFunction): void | Response => {
      if (
        req.method === 'OPTIONS' ||
        req.path.startsWith('/webhooks/meta/whatsapp') ||
        (req.method === 'GET' && readHeavyRoutes.some((route) => route.test(req.path)))
      ) {
        return next();
      }

      const now = Date.now();
      const key = req.ip || req.socket.remoteAddress || 'unknown';
      const current = hits.get(key);

      if (!current || current.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return next();
      }

      current.count += 1;
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(maxRequests - current.count, 0)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));

      if (current.count > maxRequests) {
        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Demasiadas solicitudes, intenta mas tarde',
        });
      }

      return next();
    };
  }

  private setupSwagger(): void {
    this.app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
      swaggerOptions: {
        persistAuthorization: true,
        defaultModelsExpandDepth: 1,
      },
      customCss: '.swagger-ui .topbar { display: none }',
    }));

    this.app.get('/api/docs/swagger.json', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(swaggerSpec);
    });
  }

  private async initializeDatabase(): Promise<void> {
    try {
      await User.createTableIfNotExists();
      await coreModel.createTablesIfNotExists();
      console.log('✅ Base de datos inicializada');
    } catch (error: any) {
      console.error('❌ Error inicializando BD', {
        code: String(error?.code || 'DB_INITIALIZATION_FAILED'),
      });
    }
  }

  private setupRoutes(): void {
    const core = this.conversationCore || null;

    this.app.use('/api/auth', createAuthRoutes(this.whatsappService));
    this.app.use('/api/company', requireJwt, createCompanyRoutes(this.whatsappService));
    this.app.use('/api/agents', requireJwt, createAgentRoutes());
    this.app.use('/api/catalogs', requireJwt, createCatalogRoutes());
    this.app.use('/api/tags', requireJwt, createTagRoutes());
    this.app.use('/api/commercial-items', requireJwt, createProductRoutes());
    this.app.use('/api/products', requireJwt, createProductRoutes());
    this.app.use('/api/orders', requireJwt, createOrderRoutes());
    this.app.use('/api/payments', requireJwt, createPaymentRoutes());
    this.app.use('/api/dashboard', requireJwt, createDashboardRoutes());
    this.app.use('/api/chats/ia', requireJwt, createIaPauseRoutes());
    this.app.use('/api/webhooks/payments', createPaymentWebhookRoutes());
    this.app.use('/api/customer-history', requireJwt, createCustomerHistoryRoutes());
    this.app.use('/api/conversations', requireJwt, createConversationRoutes());
    this.app.use('/api/reports', requireJwt, createReportRoutes());
    this.app.use('/api/whatsapp', requireJwt, createWhatsAppRoutes(this.whatsappService));
    this.app.use('/api/webhooks/meta/whatsapp', createMetaWebhookRoutes(this.whatsappService));
    this.app.use('/api/chats', requireJwt, createChatCompatRoutes(this.whatsappService));
    this.app.use('/api/chats', requireJwt, createChatRoutes(this.whatsappService, core));
    this.app.use('/api/media', requireJwt, createMediaRoutes(this.whatsappService));
    this.app.use('/api/v1/workflows', createWorkflowRoutes());
    this.app.use('/api/v1/ai', createAiRoutes());
    this.app.use('/api/v1/admin', createAdminRoutes());
    this.app.use('/api/v1/campaigns', createCampaignRoutes());
    this.app.use('/api/v1/consent', createConsentRoutes());
    this.app.use('/api/v1/segments', createSegmentRoutes());
    this.app.use('/api/v1/marketplace', createMarketplaceRoutes());
    this.app.use('/api/v1', createOpenApiRoutes());

    // Sandbox aislado para testing no productivo (demo fuera del endpoint productivo)
    if (config.security.allowInsecureSandbox && process.env.NODE_ENV !== 'production') {
      const sandboxRouter = express.Router();
      sandboxRouter.use('/whatsapp', optionalWhatsappJwt, createWhatsAppRoutes(this.whatsappService));
      sandboxRouter.use('/chats', optionalWhatsappJwt, createChatCompatRoutes(this.whatsappService));
      sandboxRouter.use('/chats', optionalWhatsappJwt, createChatRoutes(this.whatsappService, core));
      sandboxRouter.use('/media', optionalWhatsappJwt, createMediaRoutes(this.whatsappService));
      this.app.use('/api/sandbox', sandboxRouter);
    }

    this.setupLegacyRoutes(core);

    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        provider: config.whatsapp.provider,
        metaConfigured: config.whatsapp.provider === 'meta-cloud'
          && Boolean(config.meta.phoneNumberId && config.meta.accessToken && config.meta.appSecret),
        timestamp: new Date().toISOString(),
      });
    });
  }

  private setupLegacyRoutes(conversationCore: any): void {
    const multer = require('multer') as any;
    const upload = multer({ dest: 'uploads/' });
    const AuthController = require('./controllers/authController');
    const ChatController = require('./controllers/chatController');
    const MediaController = require('./controllers/mediaController');

    const authController = new AuthController(this.whatsappService);
    const chatController = new ChatController(this.whatsappService, conversationCore);
    const mediaController = new MediaController(this.whatsappService);

    // Rutas legacy bajo autenticación estricta (P0)
    this.app.get('/qr', requireJwt as any, authController.getQRLegacy);
    this.app.get('/status', requireJwt as any, authController.getStatusLegacy);
    this.app.get('/me', requireJwt as any, authController.getMeLegacy);
    this.app.post('/logout', requireJwt as any, authController.logoutLegacy);
    this.app.get('/chats', requireJwt as any, chatController.getChatsLegacy);
    this.app.get('/messages/:chatId', requireJwt as any, requireChatTenantAccess as any, chatController.getMessagesLegacy);
    this.app.post('/send-message', requireJwt as any, upload.single('file'), requireChatTenantAccess as any, chatController.sendMessageLegacy);
    this.app.get('/api/media/:messageId', requireJwt as any, requireMediaTenantAccess as any, mediaController.downloadMedia);
    this.app.get('/api/media/:messageId/info', requireJwt as any, requireMediaTenantAccess as any, mediaController.getMediaInfo);
    this.app.get('/api/media/:messageId/thumbnail', requireJwt as any, requireMediaTenantAccess as any, mediaController.getMediaThumbnail);
    this.app.get('/download-media/:messageId', requireJwt as any, requireMediaTenantAccess as any, mediaController.downloadMedia);
    this.app.get('/profile-photo/:chatId', requireJwt as any, requireChatTenantAccess as any, mediaController.getProfilePhoto);
  }

  private setupSocketIO(): void {
    this.whatsappService.setSocketIO(this.io);
    setSocketIo(this.io);
    this.socketHandler.handleConnection(this.io);
  }

  private setupErrorHandling(): void {
    this.app.use(notFound);
    this.app.use(errorHandler);
  }

  private setupProcessHandlers(): void {
    process.on('unhandledRejection', (reason: any) => {
      console.error('❌ Error no manejado (UNHANDLED REJECTION)', {
        code: String(reason?.code || 'UNHANDLED_REJECTION'),
        name: reason?.name || null,
      });
    });

    process.on('uncaughtException', (error: any) => {
      console.error('❌ Excepcion no capturada (UNCAUGHT EXCEPTION)', {
        code: String(error?.code || 'UNCAUGHT_EXCEPTION'),
        name: error?.name || null,
      });
    });
  }

  private async initializeConversationCore(): Promise<void> {
    if (!config.features || (!config.features.persistReads && !config.features.persistWrites)) {
      return;
    }

    try {
      const { createConversationCore } = await import('./core/infrastructure/integration/conversationCore');
      this.conversationCore = createConversationCore(
        this.whatsappService,
        this.io,
        config.defaultCompanyId || 1
      );
      this.whatsappService.setConversationCore(this.conversationCore);
      this.whatsappService.whatsappClient?.setConversationCore?.(this.conversationCore);
      console.log('✅ ConversationCore initialized (reads/writes enabled)');
    } catch (error: any) {
      console.error('❌ Failed to initialize ConversationCore:', error?.message || error);
    }
  }

  async start(): Promise<void> {
    try {
      await this.initializeDatabase();
      await this.whatsappService.initialize();
      await this.initializeConversationCore();
      this.setupRoutes();
      this.setupSocketIO();
      this.setupErrorHandling();

      this.server.listen(config.server.port, () => {
        console.log(`🚀 API + Socket.IO corriendo en http://${config.server.host}:${config.server.port}`);
        console.log(`📱 WhatsApp provider: ${this.whatsappService.provider}`);
        console.log(`🔐 JWT WhatsApp API: ${config.security.whatsappApiRequireJwt ? 'activado' : 'desactivado en desarrollo'}`);
        console.log(`📖 Swagger disponible en http://${config.server.host}:${config.server.port}/api/docs`);
      });
    } catch (error) {
      console.error('Error al iniciar la aplicacion:', error);
      process.exit(1);
    }
  }
}

export async function startApp(): Promise<void> {
  const app = new App();
  await app.start();
}
