import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const CreateGallerySchema = z.object({
  title: z.string().trim().min(1).max(150).optional().default('Finished Look'),
  place: z.string().trim().max(120).optional().nullable(),
  bookingId: z.string().uuid().optional().nullable(),
  imageUrl: z.string().max(5_000_000).optional().default(''),
  extraImages: z.array(z.string().max(5_000_000)).max(4, 'Maximum 5 photos allowed per look').optional().default([]),
  caption: z.string().trim().max(2000).optional().nullable(),
  instagramHandle: z.string().trim().max(100).optional().nullable(),
  instagramUrl: z.string().trim().max(1000).optional().nullable(),
  postedToInstagram: z.boolean().optional().default(false),
});

const UpdateGallerySchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  place: z.string().trim().max(120).optional().nullable(),
  imageUrl: z.string().max(5_000_000).optional(),
  extraImages: z.array(z.string().max(5_000_000)).max(4, 'Maximum 5 photos allowed per look').optional(),
  caption: z.string().trim().max(2000).optional().nullable(),
  instagramHandle: z.string().trim().max(100).optional().nullable(),
  instagramUrl: z.string().trim().max(1000).optional().nullable(),
  postedToInstagram: z.boolean().optional(),
});

function getWeekStartKey(date: Date): number {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const d = new Date(utc);
  const day = d.getUTCDay(); // 0 = Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000));
}

export async function computeStudioStreaks(beauticianId: string) {
  const [completedBookings, galleryLooks] = await Promise.all([
    prisma.booking.findMany({
      where: { beauticianId, status: 'completed' },
      select: { bookingDate: true, updatedAt: true },
    }),
    prisma.galleryPhoto.findMany({
      where: { beauticianId },
      select: {
        id: true,
        imageUrl: true,
        extraImages: true,
        postedToInstagram: true,
        createdAt: true,
      },
    }),
  ]);

  const completedOrders = completedBookings.length;
  const completedLookCount = galleryLooks.filter(
    (g) => Boolean(g.imageUrl?.trim()) || (Array.isArray(g.extraImages) && g.extraImages.length > 0)
  ).length;
  const postedLooks = galleryLooks.filter((g) => g.postedToInstagram).length;

  // Weekly activity streak across completed orders and posted looks
  const activeWeeks = new Set<number>();
  for (const b of completedBookings) {
    activeWeeks.add(getWeekStartKey(b.updatedAt || b.bookingDate));
  }
  for (const g of galleryLooks) {
    if (g.postedToInstagram || g.imageUrl?.trim()) {
      activeWeeks.add(getWeekStartKey(g.createdAt));
    }
  }

  const currentWeek = getWeekStartKey(new Date());
  let weeklyStreak = 0;
  let cursor = activeWeeks.has(currentWeek)
    ? currentWeek
    : activeWeeks.has(currentWeek - 1)
    ? currentWeek - 1
    : -1;

  while (cursor >= 0 && activeWeeks.has(cursor)) {
    weeklyStreak += 1;
    cursor -= 1;
  }

  // Milestone tier based on real completed orders
  let tierName = 'New Studio';
  let nextTarget = 1;
  let prevTarget = 0;
  if (completedOrders >= 25) {
    tierName = 'Shilpi Master';
    prevTarget = 25;
    nextTarget = 25;
  } else if (completedOrders >= 10) {
    tierName = 'Studio Star';
    prevTarget = 10;
    nextTarget = 25;
  } else if (completedOrders >= 5) {
    tierName = 'Pro Artist';
    prevTarget = 5;
    nextTarget = 10;
  } else if (completedOrders >= 1) {
    tierName = 'Rising Artist';
    prevTarget = 1;
    nextTarget = 5;
  }

  const progressPercent =
    completedOrders >= 25
      ? 100
      : Math.min(100, Math.round(((completedOrders - prevTarget) / Math.max(1, nextTarget - prevTarget)) * 100));

  return {
    completedOrders,
    galleryLooks: completedLookCount,
    totalCards: galleryLooks.length,
    postedLooks,
    weeklyStreak,
    tierName,
    nextTarget,
    progressPercent,
  };
}

export class GalleryController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const [looks, streaks] = await Promise.all([
        prisma.galleryPhoto.findMany({
          where: { beauticianId },
          orderBy: { createdAt: 'desc' },
        }),
        computeStudioStreaks(beauticianId),
      ]);

      res.status(200).json({
        success: true,
        data: looks,
        streaks,
      });
    } catch (error: any) {
      logger.error({ error }, 'List gallery failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = CreateGallerySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid gallery look payload.',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const {
        title,
        place,
        bookingId,
        imageUrl,
        extraImages,
        caption,
        instagramHandle,
        instagramUrl,
        postedToInstagram,
      } = parsed.data;

      if (bookingId) {
        const booking = await prisma.booking.findFirst({
          where: { id: bookingId, beauticianId },
          select: { id: true },
        });
        if (!booking) {
          res.status(404).json({ success: false, error: { message: 'Booking not found for this studio.' } });
          return;
        }

        const existingForBooking = await prisma.galleryPhoto.findFirst({
          where: { beauticianId, bookingId },
        });
        if (existingForBooking) {
          const streaks = await computeStudioStreaks(beauticianId);
          res.status(200).json({ success: true, data: existingForBooking, streaks });
          return;
        }
      }

      const look = await prisma.galleryPhoto.create({
        data: {
          beauticianId,
          bookingId: bookingId || null,
          title,
          place: place || null,
          imageUrl: imageUrl || '',
          extraImages: extraImages.filter(Boolean).slice(0, 4),
          caption: caption || null,
          instagramHandle: instagramHandle || null,
          instagramUrl: instagramUrl || null,
          postedToInstagram: Boolean(postedToInstagram),
        },
      });

      const streaks = await computeStudioStreaks(beauticianId);
      res.status(201).json({ success: true, data: look, streaks });
    } catch (error: any) {
      logger.error({ error }, 'Create gallery look failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = String(req.params.id || '');
      const parsed = UpdateGallerySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid gallery look update.',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const existing = await prisma.galleryPhoto.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Portfolio look not found.' } });
        return;
      }

      const d = parsed.data;
      const updated = await prisma.galleryPhoto.update({
        where: { id: existing.id },
        data: {
          title: d.title !== undefined ? d.title : undefined,
          place: d.place !== undefined ? d.place : undefined,
          imageUrl: d.imageUrl !== undefined ? d.imageUrl : undefined,
          extraImages:
            d.extraImages !== undefined ? d.extraImages.filter(Boolean).slice(0, 4) : undefined,
          caption: d.caption !== undefined ? d.caption : undefined,
          instagramHandle: d.instagramHandle !== undefined ? d.instagramHandle : undefined,
          instagramUrl: d.instagramUrl !== undefined ? d.instagramUrl : undefined,
          postedToInstagram: d.postedToInstagram !== undefined ? d.postedToInstagram : undefined,
        },
      });

      const streaks = await computeStudioStreaks(beauticianId);
      res.status(200).json({ success: true, data: updated, streaks });
    } catch (error: any) {
      logger.error({ error }, 'Update gallery look failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }

  static async remove(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = String(req.params.id || '');
      const existing = await prisma.galleryPhoto.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Portfolio look not found.' } });
        return;
      }

      await prisma.galleryPhoto.delete({ where: { id: existing.id } });
      const streaks = await computeStudioStreaks(beauticianId);
      res.status(200).json({ success: true, streaks });
    } catch (error: any) {
      logger.error({ error }, 'Delete gallery look failed');
      res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' } });
    }
  }
}
