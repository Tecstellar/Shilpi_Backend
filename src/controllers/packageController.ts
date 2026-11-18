import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const ServiceTypeEnum = z.enum(['bridal', 'hair', 'makeup', 'skincare', 'mehendi', 'combo']);

const CreatePackageSchema = z.object({
  name: z.string().trim().min(1, 'Package name is required').max(120),
  serviceType: ServiceTypeEnum,
  description: z.string().trim().max(1000).optional().nullable(),
  durationMinutes: z.number().int().min(5, 'Duration must be at least 5 minutes').max(1440).default(60),
  pricePaise: z.number().int().nonnegative('Price cannot be negative'),
  isActive: z.boolean().optional().default(true),
});

const UpdatePackageSchema = z.object({
  name: z.string().trim().min(1, 'Package name is required').max(120).optional(),
  serviceType: ServiceTypeEnum.optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  durationMinutes: z.number().int().min(5, 'Duration must be at least 5 minutes').max(1440).optional(),
  pricePaise: z.number().int().nonnegative('Price cannot be negative').optional(),
  isActive: z.boolean().optional(),
});

function serializePackage(pkg: {
  id: string;
  beauticianId: string;
  name: string;
  serviceType: string;
  description: string | null;
  durationMinutes: number;
  pricePaise: bigint;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: pkg.id,
    name: pkg.name,
    serviceType: pkg.serviceType,
    description: pkg.description,
    durationMinutes: pkg.durationMinutes,
    pricePaise: pkg.pricePaise.toString(),
    priceRupees: Math.round(Number(pkg.pricePaise) / 100),
    isActive: pkg.isActive,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
  };
}

export class PackageController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const packages = await prisma.servicePackage.findMany({
        where: { beauticianId },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      });

      res.status(200).json({
        success: true,
        data: packages.map(serializePackage),
      });
    } catch (error) {
      logger.error({ error }, 'List packages failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = CreatePackageSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid package details',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const { name, serviceType, description, durationMinutes, pricePaise, isActive } = parsed.data;

      const created = await prisma.servicePackage.create({
        data: {
          beauticianId,
          name: name.trim(),
          serviceType,
          description: description?.trim() || null,
          durationMinutes,
          pricePaise: BigInt(pricePaise),
          isActive,
        },
      });

      res.status(201).json({
        success: true,
        data: serializePackage(created),
      });
    } catch (error) {
      logger.error({ error }, 'Create package failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = UpdatePackageSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid package details',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const existing = await prisma.servicePackage.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Package not found' } });
        return;
      }

      const { name, serviceType, description, durationMinutes, pricePaise, isActive } = parsed.data;
      const updated = await prisma.servicePackage.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(serviceType !== undefined ? { serviceType } : {}),
          ...(description !== undefined ? { description: description?.trim() || null } : {}),
          ...(durationMinutes !== undefined ? { durationMinutes } : {}),
          ...(pricePaise !== undefined ? { pricePaise: BigInt(pricePaise) } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      });

      res.status(200).json({
        success: true,
        data: serializePackage(updated),
      });
    } catch (error) {
      logger.error({ error }, 'Update package failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async remove(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;

      const existing = await prisma.servicePackage.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Package not found' } });
        return;
      }

      await prisma.servicePackage.delete({
        where: { id: existing.id },
      });

      res.status(200).json({
        success: true,
        data: { id: existing.id },
      });
    } catch (error) {
      logger.error({ error }, 'Delete package failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }
}
