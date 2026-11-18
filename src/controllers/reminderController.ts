import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const CreateReminderSchema = z.object({
  text: z.string().trim().min(1, 'Reminder text is required').max(130),
  kind: z.string().trim().min(1).max(40).optional().default('General'),
  remindAt: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'Valid reminder date and time are required',
  }),
  bookingId: z.string().uuid().optional().nullable(),
});

const UpdateReminderSchema = z.object({
  text: z.string().trim().min(1).max(130).optional(),
  kind: z.string().trim().min(1).max(40).optional(),
  remindAt: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'Valid reminder date and time are required',
    })
    .optional(),
  isCompleted: z.boolean().optional(),
  bookingId: z.string().uuid().optional().nullable(),
});

function encodeTitle(text: string, kind?: string): string {
  const cleanText = text.trim();
  const cleanKind = (kind || 'General').trim();
  return `[${cleanKind}] ${cleanText}`.slice(0, 150);
}

function decodeTitle(rawTitle: string): { text: string; kind: string } {
  const match = /^\[([^\]]+)\]\s*(.+)$/.exec(rawTitle || '');
  if (match) {
    return {
      kind: match[1].trim() || 'General',
      text: match[2].trim(),
    };
  }
  return {
    kind: 'General',
    text: (rawTitle || '').trim(),
  };
}

function serializeReminder(r: {
  id: string;
  title: string;
  remindAt: Date;
  isCompleted: boolean;
  bookingId: string | null;
  createdAt: Date;
}) {
  const { text, kind } = decodeTitle(r.title);
  return {
    id: r.id,
    text,
    kind,
    remindAt: r.remindAt.toISOString(),
    isCompleted: r.isCompleted,
    bookingId: r.bookingId,
    createdAt: r.createdAt.toISOString(),
  };
}

export class ReminderController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const rows = await prisma.reminder.findMany({
        where: { beauticianId },
        orderBy: [{ remindAt: 'asc' }, { createdAt: 'desc' }],
        take: 100,
      });

      res.status(200).json({
        success: true,
        data: rows.map(serializeReminder),
      });
    } catch (error) {
      logger.error({ error }, 'List reminders failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = CreateReminderSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid reminder details',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const { text, kind, remindAt, bookingId } = parsed.data;

      if (bookingId) {
        const ownedBooking = await prisma.booking.findFirst({
          where: { id: bookingId, beauticianId },
          select: { id: true },
        });
        if (!ownedBooking) {
          res.status(404).json({ success: false, error: { message: 'Linked booking not found' } });
          return;
        }
      }

      const created = await prisma.reminder.create({
        data: {
          beauticianId,
          bookingId: bookingId || null,
          title: encodeTitle(text, kind),
          remindAt: new Date(remindAt),
        },
      });

      res.status(201).json({
        success: true,
        data: serializeReminder(created),
      });
    } catch (error) {
      logger.error({ error }, 'Create reminder failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = UpdateReminderSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid reminder update',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const existing = await prisma.reminder.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Reminder not found' } });
        return;
      }

      const currentDecoded = decodeTitle(existing.title);
      const nextText = parsed.data.text !== undefined ? parsed.data.text : currentDecoded.text;
      const nextKind = parsed.data.kind !== undefined ? parsed.data.kind : currentDecoded.kind;

      const updated = await prisma.reminder.update({
        where: { id: existing.id },
        data: {
          title:
            parsed.data.text !== undefined || parsed.data.kind !== undefined
              ? encodeTitle(nextText, nextKind)
              : undefined,
          remindAt: parsed.data.remindAt !== undefined ? new Date(parsed.data.remindAt) : undefined,
          isCompleted:
            parsed.data.isCompleted !== undefined ? parsed.data.isCompleted : undefined,
          bookingId: parsed.data.bookingId !== undefined ? parsed.data.bookingId : undefined,
        },
      });

      res.status(200).json({
        success: true,
        data: serializeReminder(updated),
      });
    } catch (error) {
      logger.error({ error }, 'Update reminder failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async remove(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;

      const existing = await prisma.reminder.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Reminder not found' } });
        return;
      }

      await prisma.reminder.delete({ where: { id: existing.id } });
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Delete reminder failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }
}
