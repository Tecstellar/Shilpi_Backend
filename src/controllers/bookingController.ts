import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { FinancialService } from '../services/financialService.js';
import { logger } from '../lib/logger.js';

const CreateBookingSchema = z.object({
  clientId: z.string().uuid(),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  eventLocation: z.string().optional(),
  advancePaidPaise: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      servicePackageId: z.string().uuid().optional(),
      customTitle: z.string().min(2).max(120),
      quantity: z.number().int().min(1).default(1),
      unitPricePaise: z.number().int().nonnegative(),
    })
  ).min(1, 'Booking must have at least one service item'),
});

const UpdateStatusSchema = z.object({
  status: z.enum(['enquiry', 'confirmed', 'in_progress', 'completed', 'cancelled']),
});

const RecordPaymentSchema = z.object({
  markFullyPaid: z.boolean().optional(),
  amountPaise: z.number().int().positive().optional(),
  paymentMode: z.enum(['cash', 'upi', 'bank_transfer', 'card']).default('upi'),
  notes: z.string().max(300).optional(),
});

export class BookingController {
  // List bookings with tenant isolation (Checklist #5: Bounded range & index-friendly)
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const { status, fromDate, toDate, limit = '50', page = '1' } = req.query;

      const take = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
      const skip = (Math.max(1, parseInt(page as string, 10)) - 1) * take;

      const where: any = { beauticianId };

      if (status) {
        where.status = status;
      }

      if (fromDate || toDate) {
        where.bookingDate = {};
        if (fromDate) where.bookingDate.gte = new Date(fromDate as string);
        if (toDate) where.bookingDate.lte = new Date(toDate as string);
      }

      const [total, bookings] = await Promise.all([
        prisma.booking.count({ where }),
        prisma.booking.findMany({
          where,
          take,
          skip,
          orderBy: { bookingDate: 'desc' },
          include: {
            client: { select: { id: true, name: true, phone: true } },
            items: true,
          },
        }),
      ]);

      // Format BigInt fields for JSON serialization
      const serialized = bookings.map((b) => ({
        ...b,
        totalAmountPaise: b.totalAmountPaise.toString(),
        advancePaidPaise: b.advancePaidPaise.toString(),
        balanceDuePaise: b.balanceDuePaise.toString(),
        totalAmountFormatted: FinancialService.formatRupees(b.totalAmountPaise),
        balanceDueFormatted: FinancialService.formatRupees(b.balanceDuePaise),
        items: b.items.map((i) => ({
          ...i,
          unitPricePaise: i.unitPricePaise.toString(),
          totalPricePaise: i.totalPricePaise.toString(),
        })),
      }));

      res.status(200).json({
        success: true,
        data: serialized,
        pagination: { total, page: parseInt(page as string, 10), limit: take },
      });
    } catch (error) {
      logger.error({ error }, 'List bookings failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  // Create booking with whole-integer paise financial ledger
  static async create(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = CreateBookingSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.format() });
        return;
      }

      const { clientId, bookingDate, startTime, endTime, eventLocation, advancePaidPaise, notes, items } = parsed.data;

      // Verify client belongs to this beautician (Tenant Boundary check)
      const client = await prisma.client.findFirst({
        where: { id: clientId, beauticianId },
      });

      if (!client) {
        res.status(404).json({ success: false, error: { message: 'Client not found in your directory' } });
        return;
      }

      // Compute total and dues in whole integer paise
      const calcItems = items.map((i) => ({
        unitPricePaise: BigInt(i.unitPricePaise),
        quantity: i.quantity,
      }));

      const ledger = FinancialService.calculateBookingLedger(calcItems, BigInt(advancePaidPaise));

      // Atomic transaction: create booking and items
      const booking = await prisma.$transaction(async (tx) => {
        const createdBooking = await tx.booking.create({
          data: {
            beauticianId,
            clientId,
            bookingDate: new Date(bookingDate),
            startTime: startTime ? new Date(startTime) : null,
            endTime: endTime ? new Date(endTime) : null,
            eventLocation,
            totalAmountPaise: ledger.totalPaise,
            advancePaidPaise: ledger.advancePaidPaise,
            balanceDuePaise: ledger.balanceDuePaise,
            status: ledger.advancePaidPaise > 0n ? 'confirmed' : 'enquiry',
            notes,
            items: {
              create: items.map((item) => ({
                servicePackageId: item.servicePackageId,
                customTitle: item.customTitle,
                quantity: item.quantity,
                unitPricePaise: BigInt(item.unitPricePaise),
                totalPricePaise: BigInt(item.unitPricePaise) * BigInt(item.quantity),
              })),
            },
          },
          include: {
            client: true,
            items: true,
          },
        });

        // If advance paid, record payment ledger entry
        if (ledger.advancePaidPaise > 0n) {
          await tx.payment.create({
            data: {
              bookingId: createdBooking.id,
              amountPaise: ledger.advancePaidPaise,
              paymentMode: 'cash',
              status: 'successful',
              notes: 'Advance booking deposit',
            },
          });
        }

        return createdBooking;
      }, { maxWait: 10000, timeout: 25000 });

      res.status(201).json({
        success: true,
        data: {
          ...booking,
          totalAmountPaise: booking.totalAmountPaise.toString(),
          advancePaidPaise: booking.advancePaidPaise.toString(),
          balanceDuePaise: booking.balanceDuePaise.toString(),
          totalAmountFormatted: FinancialService.formatRupees(booking.totalAmountPaise),
          items: booking.items.map((item) => ({
            ...item,
            unitPricePaise: item.unitPricePaise.toString(),
            totalPricePaise: item.totalPricePaise.toString(),
          })),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Create booking failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  // Update status (e.g. mark completed)
  static async updateStatus(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = UpdateStatusSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.format() });
        return;
      }

      const booking = await prisma.booking.findFirst({
        where: { id, beauticianId },
      });

      if (!booking) {
        res.status(404).json({ success: false, error: { message: 'Booking not found' } });
        return;
      }

      const updated = await prisma.booking.update({
        where: { id },
        data: { status: parsed.data.status },
      });

      res.status(200).json({
        success: true,
        data: {
          ...updated,
          totalAmountPaise: updated.totalAmountPaise.toString(),
          advancePaidPaise: updated.advancePaidPaise.toString(),
          balanceDuePaise: updated.balanceDuePaise.toString(),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Update booking status failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  // Record a full or partial payment against an existing booking
  static async recordPayment(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = RecordPaymentSchema.safeParse(req.body ?? {});

      if (!parsed.success) {
        res.status(400).json({ success: false, error: parsed.error.format() });
        return;
      }

      const booking = await prisma.booking.findFirst({
        where: { id, beauticianId },
      });

      if (!booking) {
        res.status(404).json({ success: false, error: { message: 'Booking not found' } });
        return;
      }

      const remainingPaise =
        booking.totalAmountPaise > booking.advancePaidPaise
          ? booking.totalAmountPaise - booking.advancePaidPaise
          : 0n;

      const requestedPaise = parsed.data.markFullyPaid
        ? remainingPaise
        : parsed.data.amountPaise !== undefined
        ? BigInt(parsed.data.amountPaise)
        : remainingPaise;

      const payPaise = requestedPaise > remainingPaise ? remainingPaise : requestedPaise;

      const updated = await prisma.$transaction(
        async (tx) => {
          if (payPaise > 0n) {
            await tx.payment.create({
              data: {
                bookingId: booking.id,
                amountPaise: payPaise,
                paymentMode: parsed.data.paymentMode,
                status: 'successful',
                notes:
                  parsed.data.notes ||
                  (payPaise === remainingPaise ? 'Full balance settled' : 'Balance payment recorded'),
              },
            });
          }

          const newAdvancePaise = booking.advancePaidPaise + payPaise;
          const newBalanceDuePaise =
            booking.totalAmountPaise > newAdvancePaise
              ? booking.totalAmountPaise - newAdvancePaise
              : 0n;

          return tx.booking.update({
            where: { id: booking.id },
            data: {
              advancePaidPaise: newAdvancePaise,
              balanceDuePaise: newBalanceDuePaise,
              status: booking.status === 'enquiry' && newAdvancePaise > 0n ? 'confirmed' : booking.status,
            },
          });
        },
        { maxWait: 10000, timeout: 25000 }
      );

      res.status(200).json({
        success: true,
        data: {
          ...updated,
          totalAmountPaise: updated.totalAmountPaise.toString(),
          advancePaidPaise: updated.advancePaidPaise.toString(),
          balanceDuePaise: updated.balanceDuePaise.toString(),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Record booking payment failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }
}
