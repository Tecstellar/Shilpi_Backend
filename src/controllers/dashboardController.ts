import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { FinancialService } from '../services/financialService.js';
import { logger } from '../lib/logger.js';

export class DashboardController {
  // Returns Studio Overview KPIs with strict 30-day bounding (Production Checklist #5)
  static async getOverview(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const isDemo = beauticianId === '00000000-0000-0000-0000-000000000002';

      if (isDemo) {
        res.status(200).json({
          success: true,
          data: {
            metrics: {
              totalClients: 24,
              monthlyBookingsCount: 8,
              totalSalesPaise: '14600000',
              totalSalesFormatted: '₹1,46,000',
              totalExpensesPaise: '3250000',
              totalExpensesFormatted: '₹32,500',
              netProfitPaise: '11350000',
              netProfitFormatted: '₹1,13,500',
              profitMarginPercentage: 77.7,
            },
            upcomingAppointments: [
              {
                id: 'b1',
                clientName: 'Priya Raghavan',
                clientPhone: '+91 98842 10233',
                bookingDate: new Date(Date.now() + 86400000 * 2).toISOString(),
                startTime: new Date(Date.now() + 86400000 * 2).toISOString(),
                eventLocation: 'Le Meridien, Coimbatore',
                balanceDueFormatted: '₹8,000',
                status: 'confirmed',
              },
              {
                id: 'b2',
                clientName: 'Divya Krishnan',
                clientPhone: '+91 90031 55420',
                bookingDate: new Date(Date.now() + 86400000 * 5).toISOString(),
                startTime: new Date(Date.now() + 86400000 * 5).toISOString(),
                eventLocation: 'Radisson Blu, Peelamedu',
                balanceDueFormatted: '₹5,500',
                status: 'confirmed',
              },
              {
                id: 'b3',
                clientName: 'Anu Menon',
                clientPhone: '+91 94430 77812',
                bookingDate: new Date(Date.now() + 86400000 * 9).toISOString(),
                startTime: new Date(Date.now() + 86400000 * 9).toISOString(),
                eventLocation: 'Studio Booking',
                balanceDueFormatted: '₹12,000',
                status: 'enquiry',
              },
            ],
          },
        });
        return;
      }
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      // Bounded queries avoiding N+1 loops (Production Checklist #2 & #5)
      const [
        totalClients,
        monthlyBookings,
        confirmedUpcoming,
        allMonthlyPayments,
        allMonthlyExpenses,
      ] = await Promise.all([
        prisma.client.count({ where: { beauticianId } }),
        prisma.booking.count({
          where: {
            beauticianId,
            bookingDate: { gte: startOfMonth, lte: endOfMonth },
          },
        }),
        prisma.booking.findMany({
          where: {
            beauticianId,
            status: { in: ['confirmed', 'in_progress'] },
            bookingDate: { gte: now },
          },
          take: 5,
          orderBy: { bookingDate: 'asc' },
          include: {
            client: { select: { name: true, phone: true } },
          },
        }),
        prisma.payment.findMany({
          where: {
            booking: { beauticianId },
            status: 'successful',
            receivedAt: { gte: startOfMonth, lte: endOfMonth },
          },
          select: { amountPaise: true },
        }),
        prisma.expense.findMany({
          where: {
            beauticianId,
            expenseDate: { gte: startOfMonth, lte: endOfMonth },
          },
          select: { amountPaise: true },
        }),
      ]);

      // Calculate whole integer paise sums
      let totalSalesPaise = 0n;
      for (const p of allMonthlyPayments) {
        totalSalesPaise += p.amountPaise;
      }

      let totalExpensesPaise = 0n;
      for (const e of allMonthlyExpenses) {
        totalExpensesPaise += e.amountPaise;
      }

      const profitLedger = FinancialService.calculateNetProfit(totalSalesPaise, totalExpensesPaise);

      res.status(200).json({
        success: true,
        data: {
          metrics: {
            totalClients,
            monthlyBookingsCount: monthlyBookings,
            totalSalesPaise: totalSalesPaise.toString(),
            totalSalesFormatted: FinancialService.formatRupees(totalSalesPaise),
            totalExpensesPaise: totalExpensesPaise.toString(),
            totalExpensesFormatted: FinancialService.formatRupees(totalExpensesPaise),
            netProfitPaise: profitLedger.netProfitPaise.toString(),
            netProfitFormatted: FinancialService.formatRupees(profitLedger.netProfitPaise),
            profitMarginPercentage: profitLedger.marginPercentage,
          },
          upcomingAppointments: confirmedUpcoming.map((b) => ({
            id: b.id,
            clientName: b.client.name,
            clientPhone: b.client.phone,
            bookingDate: b.bookingDate,
            startTime: b.startTime,
            eventLocation: b.eventLocation,
            balanceDueFormatted: FinancialService.formatRupees(b.balanceDuePaise),
            status: b.status,
          })),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Get dashboard overview failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }
}
