import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const CATEGORY_LABELS: Record<string, string> = {
  cosmetics: 'Makeup products',
  hair_products: 'Hair products',
  travel: 'Travel',
  saree_materials: 'Saree materials',
  salary: 'Staff',
  rent: 'Rent',
  utilities: 'Utilities',
  marketing: 'Marketing',
  other: 'Other',
};

const CreateExpenseSchema = z.object({
  title: z.string().trim().min(1, 'Expense title is required').max(150),
  category: z.enum([
    'cosmetics',
    'hair_products',
    'saree_materials',
    'travel',
    'salary',
    'rent',
    'utilities',
    'marketing',
    'other',
  ]),
  amountPaise: z.number().int().positive('Amount must be greater than zero'),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  notes: z.string().max(500).optional().nullable(),
});

export class ExpenseController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const expenses = await prisma.expense.findMany({
        where: { beauticianId },
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        take: 100,
      });

      const serialized = expenses.map((e) => ({
        ...e,
        amountPaise: e.amountPaise.toString(),
        categoryLabel: CATEGORY_LABELS[e.category] || 'Other',
      }));

      res.status(200).json({
        success: true,
        data: serialized,
      });
    } catch (error) {
      logger.error({ error }, 'List expenses failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const parsed = CreateExpenseSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid expense details',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const { title, category, amountPaise, expenseDate, notes } = parsed.data;

      const created = await prisma.expense.create({
        data: {
          beauticianId,
          title: title.trim(),
          category,
          amountPaise: BigInt(amountPaise),
          expenseDate: new Date(`${expenseDate}T00:00:00.000Z`),
          notes: notes?.trim() || null,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          ...created,
          amountPaise: created.amountPaise.toString(),
          categoryLabel: CATEGORY_LABELS[created.category] || 'Other',
        },
      });
    } catch (error) {
      logger.error({ error }, 'Create expense failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;
      const parsed = CreateExpenseSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid expense details',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const existing = await prisma.expense.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Expense not found' } });
        return;
      }

      const { title, category, amountPaise, expenseDate, notes } = parsed.data;
      const updated = await prisma.expense.update({
        where: { id: existing.id },
        data: {
          title: title.trim(),
          category,
          amountPaise: BigInt(amountPaise),
          expenseDate: new Date(`${expenseDate}T00:00:00.000Z`),
          notes: notes?.trim() || null,
        },
      });

      res.status(200).json({
        success: true,
        data: {
          ...updated,
          amountPaise: updated.amountPaise.toString(),
          categoryLabel: CATEGORY_LABELS[updated.category] || 'Other',
        },
      });
    } catch (error) {
      logger.error({ error }, 'Update expense failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async remove(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const id = req.params.id as string;

      const existing = await prisma.expense.findFirst({
        where: { id, beauticianId },
      });

      if (!existing) {
        res.status(404).json({ success: false, error: { message: 'Expense not found' } });
        return;
      }

      await prisma.expense.delete({ where: { id: existing.id } });
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error({ error }, 'Delete expense failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }
}
