import { Request, Response } from 'express';
import { z } from 'zod';
import { QrPairingManager } from '../lib/qrPairing.js';
import { prisma } from '../lib/prisma.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const AuthorizeQrSchema = z.object({
  sessionId: z.string().min(1),
});

export let qrPairingManagerInstance: QrPairingManager | null = null;

export const setQrPairingManager = (manager: QrPairingManager) => {
  qrPairingManagerInstance = manager;
};

export class QrPairingController {
  /**
   * Generates a new official QR pairing session for Web Terminal.
   * Can be requested via REST (HTTP POST) or Socket.io.
   */
  static async createSession(req: Request, res: Response): Promise<void> {
    try {
      if (!qrPairingManagerInstance) {
        res.status(500).json({ success: false, error: { message: 'QR pairing engine not ready' } });
        return;
      }

      const session = await qrPairingManagerInstance.createSession();
      res.status(200).json({
        success: true,
        ...session,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to create QR pairing session');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  /**
   * Resilient HTTP status polling endpoint for Web Terminal.
   * Allows Web Terminal to detect pairing even if websocket disconnects or drops.
   */
  static async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = (req.query.sessionId as string) || (req.params.sessionId as string);
      if (!sessionId) {
        res.status(400).json({ success: false, error: { message: 'Missing sessionId parameter' } });
        return;
      }

      if (!qrPairingManagerInstance) {
        res.status(500).json({ success: false, error: { message: 'QR pairing engine not ready' } });
        return;
      }

      const statusData = await qrPairingManagerInstance.getSessionStatus(sessionId);
      res.status(200).json({
        success: true,
        ...statusData,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get QR session status');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  /**
   * Endpoint called by Shilpi mobile app after scanning the QR on Web terminal.
   */
  static async authorize(req: Request, res: Response): Promise<void> {
    try {
      const parsed = AuthorizeQrSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.format() });
        return;
      }

      if (!req.user) {
        res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
        return;
      }

      const { sessionId } = parsed.data;

      // Fetch fresh user and beautician details
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        include: { beautician: true },
      });

      if (!user) {
        res.status(404).json({ success: false, error: { message: 'User not found' } });
        return;
      }

      // Generate dedicated Web session JWT token
      const webToken = jwt.sign(
        {
          userId: user.id,
          beauticianId: user.beauticianId,
          phone: user.phone,
          role: user.role,
          terminal: 'web',
        },
        config.jwt.secret,
        { expiresIn: '30d' }
      );

      if (!qrPairingManagerInstance) {
        res.status(500).json({ success: false, error: { message: 'QR pairing engine not ready' } });
        return;
      }

      // Push real-time authorization to web socket and persistent DB
      const success = await qrPairingManagerInstance.authorizeSession(sessionId, {
        token: webToken,
        user: {
          id: user.id,
          phone: user.phone,
          role: user.role,
        },
        beautician: user.beautician,
      });

      if (!success) {
        res.status(410).json({
          success: false,
          error: { message: 'QR code session has expired or is invalid. Please refresh the web terminal.' },
        });
        return;
      }

      logger.info({ sessionId, userId: user.id }, 'Mobile app successfully linked web terminal');

      res.status(200).json({
        success: true,
        message: 'Web terminal linked successfully.',
      });
    } catch (error) {
      logger.error({ error }, 'QR Authorization failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }
}
