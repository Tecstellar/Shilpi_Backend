import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

function extractDigits(raw: string): string {
  return String(raw || '').replace(/\D/g, '');
}

function getPhoneKey(raw: string): string {
  const digits = extractDigits(raw);
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length > 10 && digits.startsWith('91')) return digits.slice(-10);
  return digits;
}

function isValidPhone(raw: string): boolean {
  const key = getPhoneKey(raw);
  return key.length >= 10 && key.length <= 15;
}

function formatStoredPhone(raw: string): string {
  const trimmed = String(raw || '').trim();
  const key = getPhoneKey(trimmed);
  if (key.length === 10 && (!trimmed.startsWith('+') || /^\+?91/.test(trimmed.replace(/[\s\-()]/g, '')))) {
    return `+91 ${key.slice(0, 5)} ${key.slice(5)}`;
  }
  return trimmed;
}

const CreateClientSchema = z.object({
  name: z.string().trim().min(1, 'Client name is required.').max(100),
  phone: z
    .string()
    .trim()
    .refine(isValidPhone, 'Mobile number is required (minimum 10 digits).'),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  notes: z.string().optional(),
  profilePhotoUrl: z.string().max(5_000_000).optional().nullable(),
  photoUri: z.string().max(5_000_000).optional().nullable(),
  isVip: z.boolean().optional(),
  isActive: z.boolean().optional(),
  weddingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

const UpdateClientSchema = z.object({
  name: z.string().trim().min(1, 'Client name is required.').max(100).optional(),
  phone: z
    .string()
    .trim()
    .refine(isValidPhone, 'Mobile number is required (minimum 10 digits).')
    .optional(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  address: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  profilePhotoUrl: z.string().max(5_000_000).optional().nullable(),
  photoUri: z.string().max(5_000_000).optional().nullable(),
  isVip: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const BulkImportSchema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        phone: z.string().trim().optional().default(''),
        notes: z.string().optional(),
      })
    )
    .min(1, 'Select at least one contact to import.')
    .max(200),
});

const ToggleVipSchema = z.object({
  isVip: z.boolean(),
});

const ToggleStatusSchema = z.object({
  isActive: z.boolean(),
});

export class ClientController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const { search, limit = '200', page = '1' } = req.query;

      const take = Math.min(200, Math.max(1, parseInt(limit as string, 10)));
      const skip = (Math.max(1, parseInt(page as string, 10)) - 1) * take;

      const where: any = { beauticianId };
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
        ];
      }

      const [total, clients] = await Promise.all([
        prisma.client.count({ where }),
        prisma.client.findMany({
          where,
          take,
          skip,
          orderBy: { name: 'asc' },
          include: {
            _count: { select: { bookings: true } },
          },
        }),
      ]);

      res.status(200).json({
        success: true,
        data: clients,
        pagination: { total, page: parseInt(page as string, 10), limit: take },
      });
    } catch (error) {
      logger.error({ error }, 'List clients failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = CreateClientSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid client details.',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const { name, phone, email, address, notes, profilePhotoUrl, photoUri, isVip, isActive, weddingDate } = parsed.data;
      const incomingKey = getPhoneKey(phone);
      const cleanPhone = formatStoredPhone(phone);
      const resolvedPhotoUrl = profilePhotoUrl !== undefined ? profilePhotoUrl : photoUri;

      const existingClients = await prisma.client.findMany({
        where: { beauticianId },
        select: { id: true, name: true, phone: true },
      });
      const duplicate = existingClients.find((c) => getPhoneKey(c.phone) === incomingKey);

      if (duplicate) {
        res.status(409).json({
          success: false,
          error: {
            code: 'DUPLICATE_CLIENT_PHONE',
            existingName: duplicate.name,
            existingClientId: duplicate.id,
            message: `This client was already registered in the name of "${duplicate.name}".`,
          },
        });
        return;
      }

      const client = await prisma.client.create({
        data: {
          beauticianId,
          name: name.trim(),
          phone: cleanPhone,
          email: email || null,
          address: address || null,
          notes: notes?.trim() || null,
          profilePhotoUrl: resolvedPhotoUrl || null,
          isVip: isVip ?? false,
          isActive: isActive ?? true,
          weddingDate: weddingDate ? new Date(weddingDate) : null,
        },
      });

      logger.info({ clientId: client.id, beauticianId, phone: cleanPhone }, 'Client saved to database');
      res.status(201).json({ success: true, data: client });
    } catch (error: any) {
      logger.error({ error }, 'Create client failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }

  static async bulkImport(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = BulkImportSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid contacts payload.',
          },
        });
        return;
      }

      const existingClients = await prisma.client.findMany({
        where: { beauticianId },
        select: { id: true, name: true, phone: true },
      });

      const phoneMap = new Map<string, { id: string; name: string }>();
      for (const c of existingClients) {
        const key = getPhoneKey(c.phone);
        if (key) phoneMap.set(key, { id: c.id, name: c.name });
      }

      const imported: any[] = [];
      const skippedDuplicates: { name: string; phone: string; existingName: string; message: string }[] = [];
      const skippedInvalid: { name: string; phone: string; reason: string }[] = [];

      for (const contact of parsed.data.contacts) {
        const cleanName = contact.name.trim();
        const rawPhone = (contact.phone || '').trim();
        if (!rawPhone || !isValidPhone(rawPhone)) {
          skippedInvalid.push({
            name: cleanName,
            phone: rawPhone,
            reason: 'Mobile number is missing or invalid.',
          });
          continue;
        }

        const key = getPhoneKey(rawPhone);
        const dup = phoneMap.get(key);
        if (dup) {
          skippedDuplicates.push({
            name: cleanName,
            phone: rawPhone,
            existingName: dup.name,
            message: `This client was already registered in the name of "${dup.name}".`,
          });
          continue;
        }

        const formattedPhone = formatStoredPhone(rawPhone);
        const created = await prisma.client.create({
          data: {
            beauticianId,
            name: cleanName,
            phone: formattedPhone,
            notes: contact.notes?.trim() || null,
            isActive: true,
          },
        });

        phoneMap.set(key, { id: created.id, name: created.name });
        imported.push(created);
      }

      res.status(201).json({
        success: true,
        data: {
          imported,
          skippedDuplicates,
          skippedInvalid,
        },
      });
    } catch (error: any) {
      logger.error({ error }, 'Bulk import clients failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = UpdateClientSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { message: parsed.error.issues[0]?.message || 'Invalid client details.' },
        });
        return;
      }

      const existing = await prisma.client.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Client not found in your directory' } });
        return;
      }

      const data = parsed.data;
      let nextPhone: string | undefined;
      if (data.phone !== undefined) {
        const incomingKey = getPhoneKey(data.phone);
        const otherClients = await prisma.client.findMany({
          where: { beauticianId, id: { not: existing.id } },
          select: { id: true, name: true, phone: true },
        });
        const duplicate = otherClients.find((c) => getPhoneKey(c.phone) === incomingKey);
        if (duplicate) {
          res.status(409).json({
            success: false,
            error: {
              code: 'DUPLICATE_CLIENT_PHONE',
              existingName: duplicate.name,
              existingClientId: duplicate.id,
              message: `This client was already registered in the name of "${duplicate.name}".`,
            },
          });
          return;
        }
        nextPhone = formatStoredPhone(data.phone);
      }

      const resolvedPhoto = data.profilePhotoUrl !== undefined ? data.profilePhotoUrl : data.photoUri;

      const updated = await prisma.client.update({
        where: { id: existing.id },
        data: {
          name: data.name !== undefined ? data.name.trim() : undefined,
          phone: nextPhone,
          email: data.email !== undefined ? data.email || null : undefined,
          address: data.address !== undefined ? data.address || null : undefined,
          notes: data.notes !== undefined ? (data.notes?.trim() || null) : undefined,
          profilePhotoUrl: resolvedPhoto !== undefined ? resolvedPhoto || null : undefined,
          isVip: data.isVip !== undefined ? data.isVip : undefined,
          isActive: data.isActive !== undefined ? data.isActive : undefined,
        },
        include: {
          _count: { select: { bookings: true } },
        },
      });

      res.status(200).json({ success: true, data: updated });
    } catch (error: any) {
      logger.error({ error }, 'Update client failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }

  static async updateVip(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = ToggleVipSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.format() });
        return;
      }

      const existing = await prisma.client.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Client not found in your directory' } });
        return;
      }

      const updated = await prisma.client.update({
        where: { id: existing.id },
        data: { isVip: parsed.data.isVip },
      });

      res.status(200).json({ success: true, data: updated });
    } catch (error: any) {
      logger.error({ error }, 'Update client VIP failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }

  static async updateStatus(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = ToggleStatusSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.format() });
        return;
      }

      const existing = await prisma.client.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Client not found in your directory' } });
        return;
      }

      const updated = await prisma.client.update({
        where: { id: existing.id },
        data: { isActive: parsed.data.isActive },
      });

      res.status(200).json({ success: true, data: updated });
    } catch (error: any) {
      logger.error({ error }, 'Update client status failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }
}
