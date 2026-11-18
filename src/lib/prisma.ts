import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

// Global single instance with connection pool management (Production Checklist #1)
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Log slow queries (>200ms) or database errors
// @ts-ignore
prisma.$on('error', (e: any) => {
  logger.error({ error: e }, 'Database error occurred');
});
