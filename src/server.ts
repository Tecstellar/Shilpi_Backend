import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { QrPairingManager } from './lib/qrPairing.js';
import { setQrPairingManager } from './controllers/qrPairingController.js';
import { v1Router } from './routes/v1Router.js';

const app = express();
const server = http.createServer(app);

// Security & Middlewares
app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use(
  (pinoHttp as any)({
    logger,
    autoLogging: {
      ignore: (req: any) => req.url === '/api/v1/healthz',
    },
  })
);

// Setup Socket.io for Real-time WhatsApp-style QR Pairing & Sync
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const qrManager = new QrPairingManager(io);
setQrPairingManager(qrManager);

// Root Welcome & Discovery Endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'Shilpi Studio ERP API & Real-time Gateway',
    version: '1.0.0',
    status: 'online',
    endpoints: {
      health: '/api/v1/healthz',
      apiDocs: '/api/v1',
    },
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/v1', v1Router);

// Fallback 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} does not exist.` },
  });
});

// Start Server
server.listen(config.port, () => {
  logger.info(`🚀 SHILPI Node.js TypeScript API & WebSocket Server active on port ${config.port}`);
  logger.info(`📊 Health endpoint available at http://localhost:${config.port}/api/v1/healthz`);
});

// Graceful Shutdown Handler (Production Checklist #1)
const gracefulShutdown = () => {
  logger.info('Received shutdown signal, terminating server gracefully...');
  server.close(() => {
    logger.info('HTTP & WebSocket server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
