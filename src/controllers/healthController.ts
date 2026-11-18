import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export class HealthController {
  static async check(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    try {
      // Production Checklist #8: Verify real DB connection pool health
      await prisma.$queryRaw`SELECT 1`;
      const durationMs = Date.now() - startTime;

      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected',
        latencyMs: durationMs,
        uptimeSeconds: Math.floor(process.uptime()),
        version: '1.0.0',
      });
    } catch (error) {
      logger.error({ error }, 'Healthcheck failed: Database unreachable');
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: 'Database connection failed',
      });
    }
  }
}
