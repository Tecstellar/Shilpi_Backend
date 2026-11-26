import { Server as SocketIOServer, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import QRCode from 'qrcode';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

export interface PairingSession {
  sessionId: string;
  socketId?: string | null;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'paired' | 'expired';
  authPayload?: any;
}

// In-memory active sessions map (backed by PostgreSQL qr_pairing_sessions table)
const activeSessions = new Map<string, PairingSession>();

// Cleanup stale sessions every 60 seconds (both in-memory and PostgreSQL)
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (session.expiresAt < now) {
      activeSessions.delete(id);
    }
  }
  try {
    await prisma.$executeRawUnsafe(
      'DELETE FROM qr_pairing_sessions WHERE expires_at < NOW() - INTERVAL \'5 minutes\''
    );
  } catch {
    // Silent catch for background cleanup
  }
}, 60000);

export class QrPairingManager {
  private io: SocketIOServer;

  constructor(io: SocketIOServer) {
    this.io = io;
    this.setupListeners();
  }

  /**
   * Generates a new verified QR pairing session with a strict 5-minute validity.
   * Persisted both in high-speed memory and Amazon RDS PostgreSQL.
   */
  public async createSession(socketId?: string): Promise<{
    sessionId: string;
    qrDataUrl: string;
    expiresInSeconds: number;
  }> {
    const sessionId = randomUUID();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

    const session: PairingSession = {
      sessionId,
      socketId: socketId || null,
      createdAt: Date.now(),
      expiresAt,
      status: 'pending',
    };

    activeSessions.set(sessionId, session);

    // Persist session to PostgreSQL so restarts or distributed instances never lose it
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO qr_pairing_sessions (id, socket_id, status, expires_at, created_at)
         VALUES ($1, $2, 'pending', $3, NOW())
         ON CONFLICT (id) DO UPDATE SET socket_id = $2, expires_at = $3, status = 'pending'`,
        sessionId,
        socketId || null,
        new Date(expiresAt)
      );
    } catch (dbErr) {
      logger.warn({ error: dbErr }, 'Could not persist QR session to PostgreSQL, using memory store');
    }

    // Payload encoded in the QR code that the mobile camera reads
    const qrPayload = JSON.stringify({
      app: 'shilpi',
      action: 'link_terminal',
      sessionId,
      timestamp: Date.now(),
    });

    // Generate crisp base64 Data URL
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
      color: {
        dark: '#1e293b',
        light: '#ffffff',
      },
    });

    logger.info({ sessionId, socketId }, 'Generated persistent QR pairing session');

    return {
      sessionId,
      qrDataUrl,
      expiresInSeconds: 300,
    };
  }

  private setupListeners() {
    this.io.on('connection', (socket: Socket) => {
      logger.info({ socketId: socket.id }, 'Web/Mobile socket connected');

      // Web Terminal requests a new pairing QR code
      socket.on('request_pairing_qr', async () => {
        try {
          const sessionData = await this.createSession(socket.id);

          // Join dedicated room for this session
          socket.join(`session:${sessionData.sessionId}`);

          socket.emit('pairing_qr_generated', sessionData);
        } catch (error) {
          logger.error({ error }, 'Failed to generate pairing QR');
          socket.emit('pairing_error', { message: 'Failed to generate QR code' });
        }
      });

      // Socket reconnecting or rejoining an existing active session
      socket.on('join_session', async ({ sessionId }: { sessionId: string }) => {
        if (!sessionId) return;
        socket.join(`session:${sessionId}`);

        // Update socketId mapping in memory and DB
        const session = activeSessions.get(sessionId);
        if (session) {
          session.socketId = socket.id;
          if (session.status === 'paired' && session.authPayload) {
            // Already authorized while socket was reconnecting; deliver payload immediately!
            socket.emit('pairing_authenticated', {
              success: true,
              ...session.authPayload,
              pairedAt: new Date().toISOString(),
            });
          }
        }
      });

      // On socket disconnect:
      // CRITICAL: DO NOT DELETE ACTIVE SESSIONS ON DISCONNECT!
      // A user reading a QR code on a screen must not lose their session
      // because of a 500ms network blip, long-poll cycle, or tab switch.
      socket.on('disconnect', (reason) => {
        logger.debug({ socketId: socket.id, reason }, 'Socket disconnected - active sessions preserved');
      });
    });
  }

  /**
   * Called when mobile app scans and authorizes the session.
   * Checks both in-memory store and PostgreSQL database.
   */
  public async authorizeSession(
    sessionId: string,
    authPayload: {
      token: string;
      user: any;
      beautician: any;
    }
  ): Promise<boolean> {
    const now = Date.now();
    let session = activeSessions.get(sessionId);

    // If not in memory, check PostgreSQL (handles cross-process, PM2 cluster, or server restart)
    if (!session) {
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT id, socket_id, status, expires_at FROM qr_pairing_sessions WHERE id = $1 AND expires_at > NOW()`,
          sessionId
        );
        if (rows && rows.length > 0) {
          session = {
            sessionId: rows[0].id,
            socketId: rows[0].socket_id,
            createdAt: now,
            expiresAt: new Date(rows[0].expires_at).getTime(),
            status: rows[0].status,
          };
          activeSessions.set(sessionId, session);
        }
      } catch (dbErr) {
        logger.error({ dbErr, sessionId }, 'Failed to query qr_pairing_sessions table');
      }
    }

    if (!session) {
      logger.warn({ sessionId }, 'Session not found in memory or database during authorization');
      return false;
    }

    if (session.expiresAt < now) {
      activeSessions.delete(sessionId);
      logger.warn({ sessionId, expiresAt: session.expiresAt, now }, 'Session has expired');
      return false;
    }

    // Mark as paired and store the credentials
    session.status = 'paired';
    session.authPayload = authPayload;

    // Persist paired state in PostgreSQL
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE qr_pairing_sessions SET status = 'paired', auth_payload = $1 WHERE id = $2`,
        JSON.stringify(authPayload),
        sessionId
      );
    } catch (dbErr) {
      logger.warn({ dbErr, sessionId }, 'Could not update paired state in PostgreSQL');
    }

    // Broadcast instant real-time authentication to the connected Web terminal
    this.io.to(`session:${sessionId}`).emit('pairing_authenticated', {
      success: true,
      token: authPayload.token,
      user: authPayload.user,
      beautician: authPayload.beautician,
      pairedAt: new Date().toISOString(),
    });

    logger.info({ sessionId }, 'QR session successfully authorized by mobile device');
    // Note: Do NOT delete session immediately; keep it for 5 minutes so status polling can read it safely
    return true;
  }

  /**
   * Resilient HTTP polling fallback for Web Terminal:
   * Returns current status of the pairing session ('pending', 'paired', or 'expired').
   */
  public async getSessionStatus(sessionId: string): Promise<{
    status: 'pending' | 'paired' | 'expired' | 'invalid';
    expiresInSeconds?: number;
    token?: string;
    user?: any;
    beautician?: any;
  }> {
    const now = Date.now();
    let session = activeSessions.get(sessionId);

    // 1. Check in-memory store
    if (session) {
      if (session.status === 'paired' && session.authPayload) {
        return {
          status: 'paired',
          token: session.authPayload.token,
          user: session.authPayload.user,
          beautician: session.authPayload.beautician,
        };
      }
      if (session.expiresAt > now) {
        return {
          status: 'pending',
          expiresInSeconds: Math.max(0, Math.ceil((session.expiresAt - now) / 1000)),
        };
      }
      return { status: 'expired' };
    }

    // 2. Fallback to PostgreSQL
    try {
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT status, auth_payload, expires_at FROM qr_pairing_sessions WHERE id = $1`,
        sessionId
      );
      if (rows && rows.length > 0) {
        const row = rows[0];
        const expiresAt = new Date(row.expires_at).getTime();

        if (row.status === 'paired' && row.auth_payload) {
          try {
            const payload = typeof row.auth_payload === 'string' ? JSON.parse(row.auth_payload) : row.auth_payload;
            return {
              status: 'paired',
              token: payload.token,
              user: payload.user,
              beautician: payload.beautician,
            };
          } catch {
            return { status: 'paired' };
          }
        }

        if (expiresAt > now) {
          return {
            status: 'pending',
            expiresInSeconds: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
          };
        }
        return { status: 'expired' };
      }
    } catch (err) {
      logger.error({ err, sessionId }, 'Error checking session status in DB');
    }

    return { status: 'invalid' };
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
