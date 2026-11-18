import { Server as SocketIOServer, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import QRCode from 'qrcode';
import { logger } from './logger.js';

interface PairingSession {
  sessionId: string;
  socketId: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'paired' | 'expired';
}

// In-memory active sessions map (expiring after 5 minutes)
const activeSessions = new Map<string, PairingSession>();

// Cleanup stale sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (session.expiresAt < now) {
      activeSessions.delete(id);
    }
  }
}, 60000);

export class QrPairingManager {
  private io: SocketIOServer;

  constructor(io: SocketIOServer) {
    this.io = io;
    this.setupListeners();
  }

  private setupListeners() {
    this.io.on('connection', (socket: Socket) => {
      logger.info({ socketId: socket.id }, 'Web/Mobile socket connected');

      // Web Terminal requests a new pairing QR code
      socket.on('request_pairing_qr', async () => {
        try {
          const sessionId = randomUUID();
          const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

          activeSessions.set(sessionId, {
            sessionId,
            socketId: socket.id,
            createdAt: Date.now(),
            expiresAt,
            status: 'pending',
          });

          // Join socket room dedicated to this session
          socket.join(`session:${sessionId}`);

          // Payload encoded in the QR code that the mobile camera reads
          const qrPayload = JSON.stringify({
            app: 'shilpi',
            action: 'link_terminal',
            sessionId,
            timestamp: Date.now(),
          });

          // Generate base64 Data URL for easy rendering on web
          const qrDataUrl = await QRCode.toDataURL(qrPayload, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 256,
            color: {
              dark: '#1e293b', // Slate 800 (clean anti-white-label color)
              light: '#ffffff',
            },
          });

          socket.emit('pairing_qr_generated', {
            sessionId,
            qrDataUrl,
            expiresInSeconds: 300,
          });

          logger.info({ sessionId, socketId: socket.id }, 'Generated dynamic QR pairing token');
        } catch (error) {
          logger.error({ error }, 'Failed to generate pairing QR');
          socket.emit('pairing_error', { message: 'Failed to generate QR code' });
        }
      });

      // Handle user disconnect
      socket.on('disconnect', () => {
        for (const [id, session] of activeSessions.entries()) {
          if (session.socketId === socket.id) {
            activeSessions.delete(id);
          }
        }
      });
    });
  }

  // Called when mobile app scans and authorizes the session
  public authorizeSession(
    sessionId: string,
    authPayload: {
      token: string;
      user: any;
      beautician: any;
    }
  ): boolean {
    const session = activeSessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.expiresAt < Date.now()) {
      activeSessions.delete(sessionId);
      return false;
    }

    session.status = 'paired';

    // Broadcast instant authentication to the connected Web terminal
    this.io.to(`session:${sessionId}`).emit('pairing_authenticated', {
      success: true,
      token: authPayload.token,
      user: authPayload.user,
      beautician: authPayload.beautician,
      pairedAt: new Date().toISOString(),
    });

    logger.info({ sessionId }, 'QR session successfully authorized by mobile device');
    activeSessions.delete(sessionId);
    return true;
  }

  // Cross-device synchronization broadcast
  public broadcastDataSync(beauticianId: string, eventName: string, payload: any) {
    this.io.to(`beautician:${beauticianId}`).emit('data_sync', {
      event: eventName,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}
