import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';

export interface AuthenticatedUser {
  userId: string;
  beauticianId: string;
  phone: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      beauticianId?: string;
    }
  }
}

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    res.status(401).json({
      success: false,
      error: { code: 'TOKEN_MISSING', message: 'Authentication token is required.' },
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as AuthenticatedUser;
    if (!decoded?.beauticianId) {
      res.status(401).json({
        success: false,
        error: { code: 'TOKEN_INVALID', message: 'Invalid authentication token payload.' },
      });
      return;
    }

    const studio = await prisma.beautician.findUnique({
      where: { id: decoded.beauticianId },
      select: { id: true },
    });

    if (!studio) {
      res.status(401).json({
        success: false,
        error: { code: 'STUDIO_NOT_FOUND', message: 'Authenticated studio no longer exists. Please sign in again.' },
      });
      return;
    }

    req.user = decoded;
    req.beauticianId = decoded.beauticianId;
    next();
  } catch (err) {
    res.status(401).json({
      success: false,
      error: { code: 'TOKEN_INVALID', message: 'Invalid or expired authentication token.' },
    });
  }
};
