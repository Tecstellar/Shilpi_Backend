import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { OtpService } from '../services/otpService.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const normalizeTenDigitIndianPhone = (raw: string): string => {
  const compact = raw.replace(/[\s\-()]+/g, '');
  if (/^\+91\d{10}$/.test(compact)) return compact;
  if (/^91\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+91${compact}`;
  return compact;
};

const TenDigitPhoneSchema = z
  .string()
  .trim()
  .transform(normalizeTenDigitIndianPhone)
  .refine((val) => /^\+91\d{10}$/.test(val), {
    message: 'Please enter a valid 10-digit mobile number.',
  });

const SendOtpSchema = z.object({
  phone: TenDigitPhoneSchema,
});

const VerifyOtpSchema = z.object({
  phone: TenDigitPhoneSchema,
  otp: z.string().length(6, 'Please enter the 6-digit verification code.'),
});

const RegisterSchema = z.object({
  phone: TenDigitPhoneSchema,
  ownerName: z.string().min(2).max(100),
  businessName: z.string().min(2).max(150),
  businessTypes: z.array(z.string()).optional().default([]),
  address: z.string().optional(),
  city: z.string().optional(),
  pincode: z.string().optional(),
  logoUri: z.string().optional(),
  activeTheme: z.enum(['signature', 'mehendi', 'kumkum', 'indigo']).default('signature'),
  themeMode: z.enum(['dark', 'light']).default('dark'),
  packages: z
    .array(
      z.object({
        name: z.string(),
        price: z.union([z.number(), z.string()]),
        serviceType: z.string().optional(),
      })
    )
    .optional(),
});

export class AuthController {
  static async sendOtp(req: Request, res: Response): Promise<void> {
    try {
      const parsed = SendOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Please enter a valid 10-digit mobile number.',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const clientIp =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        '127.0.0.1';
      const result = await OtpService.sendOtp(parsed.data.phone, clientIp);
      if (!result.success) {
        res.status(429).json({ success: false, error: { message: result.message, waitSeconds: result.waitSeconds } });
        return;
      }

      res.status(200).json({ success: true, message: result.message, waitSeconds: result.waitSeconds });
    } catch (error) {
      logger.error({ error }, 'Send OTP failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async verifyOtp(req: Request, res: Response): Promise<void> {
    try {
      const parsed = VerifyOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Please enter a valid 10-digit mobile number.',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const { phone, otp } = parsed.data;
      const verifyResult = await OtpService.verifyOtp(phone, otp);

      if (!verifyResult.success) {
        res.status(400).json({ success: false, error: { message: verifyResult.message } });
        return;
      }

      // Only the primary showcase number (+919876543210) auto-provisions a pre-filled demo studio.
      // Additional demo OTP numbers like +918888888888 use OTP 123456 but go through normal user registration.
      const digitsOnly = phone.replace(/\D/g, '');
      const isPrebuiltDemo = digitsOnly === '9876543210' || digitsOnly === '919876543210';

      if (isPrebuiltDemo) {
        const canonicalPhone = '+919876543210';
        const demoSeed = {
          ownerName: 'Shilpa R.',
          businessName: 'Shilpi Makeovers',
          city: 'Coimbatore',
          address: 'RS Puram, Coimbatore',
          pincode: '641002',
          businessTypes: ['Makeup Artist', 'Bridal Artist'],
        };

        let demoUser = await prisma.user.findUnique({
          where: { phone: canonicalPhone },
          include: {
            beautician: {
              include: { subscription: true },
            },
          },
        });

        if (!demoUser) {
          demoUser = await prisma.$transaction(async (tx) => {
            const beautician = await tx.beautician.upsert({
              where: { phone: canonicalPhone },
              update: {},
              create: {
                phone: canonicalPhone,
                ownerName: demoSeed.ownerName,
                businessName: demoSeed.businessName,
                city: demoSeed.city,
                address: demoSeed.address,
                pincode: demoSeed.pincode,
                businessTypes: demoSeed.businessTypes,
                status: 'active',
                activeTheme: 'signature',
                themeMode: 'dark',
                subscription: {
                  create: {
                    tier: 'free',
                    status: 'active',
                    currentPeriodStart: new Date(),
                    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    clientLimit: 15,
                    galleryLimit: 20,
                  },
                },
              },
            });

            return tx.user.create({
              data: {
                beauticianId: beautician.id,
                phone: canonicalPhone,
                role: 'owner',
                lastLoginAt: new Date(),
              },
              include: {
                beautician: {
                  include: { subscription: true },
                },
              },
            });
          }, { maxWait: 10000, timeout: 30000 });
        } else {
          await prisma.user.update({
            where: { id: demoUser.id },
            data: { lastLoginAt: new Date() },
          });
        }

        const demoToken = jwt.sign(
          {
            userId: demoUser.id,
            beauticianId: demoUser.beauticianId,
            phone: demoUser.phone,
            role: demoUser.role,
          },
          config.jwt.secret,
          { expiresIn: '30d' }
        );

        res.status(200).json({
          success: true,
          isNewUser: false,
          token: demoToken,
          user: {
            id: demoUser.id,
            phone: demoUser.phone,
            role: demoUser.role,
          },
          beautician: demoUser.beautician,
        });
        return;
      }

      const existingUser = await prisma.user.findUnique({
        where: { phone },
        include: {
          beautician: {
            include: { subscription: true },
          },
        },
      });

      if (!existingUser) {
        // Needs onboarding registration
        res.status(200).json({
          success: true,
          isNewUser: true,
          message: 'Phone verified. Please complete registration.',
          phone,
        });
        return;
      }

      // Generate JWT Token
      const token = jwt.sign(
        {
          userId: existingUser.id,
          beauticianId: existingUser.beauticianId,
          phone: existingUser.phone,
          role: existingUser.role,
        },
        config.jwt.secret,
        { expiresIn: '30d' }
      );

      // Update last login
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { lastLoginAt: new Date() },
      });

      res.status(200).json({
        success: true,
        isNewUser: false,
        token,
        user: {
          id: existingUser.id,
          phone: existingUser.phone,
          role: existingUser.role,
        },
        beautician: existingUser.beautician,
      });
    } catch (error) {
      logger.error({ error }, 'Verify OTP failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  static async register(req: Request, res: Response): Promise<void> {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            message: parsed.error.issues[0]?.message || 'Invalid registration details.',
            details: parsed.error.format(),
          },
        });
        return;
      }

      const {
        phone,
        ownerName,
        businessName,
        businessTypes,
        address,
        city,
        pincode,
        logoUri,
        activeTheme,
        themeMode,
        packages,
      } = parsed.data;

      // Verify that phone was actually verified in production (demo numbers always allowed)
      const digitsOnly = phone.replace(/\D/g, '');
      const isDemo =
        digitsOnly === '9876543210' ||
        digitsOnly === '919876543210' ||
        digitsOnly === '8888888888' ||
        digitsOnly === '918888888888';

      if (!isDemo && config.nodeEnv === 'production') {
        const verifiedOtp = await prisma.otpVerification.findFirst({
          where: { phone, isVerified: true },
          orderBy: { createdAt: 'desc' },
        });
        if (!verifiedOtp) {
          res.status(400).json({ success: false, error: { message: 'Phone number has not been verified.' } });
          return;
        }
      }

      const defaultServices = [
        { name: 'Bridal HD Makeup & Hair', pricePaise: BigInt(1500000), serviceType: 'bridal' as const },
        { name: 'Bridal Airbrush Makeup', pricePaise: BigInt(1800000), serviceType: 'bridal' as const },
        { name: 'Reception & Sangeet Glam', pricePaise: BigInt(1000000), serviceType: 'makeup' as const },
        { name: 'Engagement & Muhurtham Look', pricePaise: BigInt(850000), serviceType: 'makeup' as const },
        { name: 'Guest / Party Makeup', pricePaise: BigInt(350000), serviceType: 'makeup' as const },
      ];

      const packageRowsNoBeautician =
        packages && packages.length > 0
          ? packages.map((pkg) => {
              const priceNum =
                typeof pkg.price === 'string'
                  ? parseFloat(pkg.price.replace(/[^0-9.]/g, '')) || 0
                  : pkg.price;
              return {
                name: pkg.name,
                serviceType: (pkg.serviceType as any) || 'bridal',
                pricePaise: BigInt(Math.round(priceNum * 100)),
                durationMinutes: 60,
                isActive: true,
              };
            })
          : defaultServices.map((svc) => ({
              name: svc.name,
              serviceType: svc.serviceType,
              pricePaise: svc.pricePaise,
              durationMinutes: 60,
              isActive: true,
            }));

      const now = new Date();
      const nextMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const existingShop = await prisma.beautician.findUnique({
        where: { phone },
        include: {
          users: { where: { phone }, take: 1 },
          _count: { select: { servicePackages: true } },
        },
      });

      let result: { beautician: any; user: any };

      if (!existingShop) {
        const created = await prisma.beautician.create({
          data: {
            phone,
            ownerName,
            businessName,
            businessTypes: businessTypes || [],
            address: address || null,
            city: city || null,
            pincode: pincode || null,
            profilePhotoUrl: logoUri || null,
            activeTheme: activeTheme || 'signature',
            themeMode: themeMode || 'dark',
            status: 'active',
            users: {
              create: {
                phone,
                role: 'owner',
                lastLoginAt: now,
              },
            },
            subscription: {
              create: {
                tier: 'free',
                status: 'active',
                currentPeriodStart: now,
                currentPeriodEnd: nextMonth,
                clientLimit: 15,
                galleryLimit: 20,
              },
            },
            ...(packageRowsNoBeautician.length > 0
              ? { servicePackages: { createMany: { data: packageRowsNoBeautician } } }
              : {}),
          },
          include: {
            users: { where: { phone }, take: 1 },
          },
        });
        result = { beautician: created, user: created.users[0] };
      } else {
        result = await prisma.$transaction(async (tx) => {
          const beautician = await tx.beautician.update({
            where: { phone },
            data: {
              ownerName,
              businessName,
              businessTypes: businessTypes || [],
              address: address || null,
              city: city || null,
              pincode: pincode || null,
              profilePhotoUrl: logoUri || null,
              activeTheme: activeTheme || 'signature',
              themeMode: themeMode || 'dark',
            },
          });

          const user = await tx.user.upsert({
            where: { phone },
            update: {
              beauticianId: beautician.id,
              lastLoginAt: now,
            },
            create: {
              beauticianId: beautician.id,
              phone,
              role: 'owner',
              lastLoginAt: now,
            },
          });

          await tx.subscription.upsert({
            where: { beauticianId: beautician.id },
            update: { status: 'active' },
            create: {
              beauticianId: beautician.id,
              tier: 'free',
              status: 'active',
              currentPeriodStart: now,
              currentPeriodEnd: nextMonth,
              clientLimit: 15,
              galleryLimit: 20,
            },
          });

          if (existingShop._count.servicePackages === 0 && packageRowsNoBeautician.length > 0) {
            await tx.servicePackage.createMany({
              data: packageRowsNoBeautician.map((row) => ({
                ...row,
                beauticianId: beautician.id,
              })),
            });
          }

          return { beautician, user };
        }, { maxWait: 10000, timeout: 30000 });
      }

      // Cleanup verified OTP asynchronously without blocking client response
      void prisma.otpVerification.deleteMany({ where: { phone } }).catch(() => {});

      const token = jwt.sign(
        {
          userId: result.user.id,
          beauticianId: result.beautician.id,
          phone: result.user.phone,
          role: result.user.role,
        },
        config.jwt.secret,
        { expiresIn: '30d' }
      );

      res.status(201).json({
        success: true,
        token,
        user: {
          id: result.user.id,
          phone: result.user.phone,
          role: result.user.role,
        },
        beautician: result.beautician,
      });
    } catch (error: any) {
      logger.error({ error }, 'Registration failed');
      if (error.code === 'P2002') {
        res.status(409).json({ success: false, error: { message: 'An account with this phone already exists.' } });
        return;
      }
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  /**
   * GET /api/v1/auth/me
   * Return the authenticated user's studio profile and active service packages
   */
  static async me(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const [beautician, packages, user] = await Promise.all([
        prisma.beautician.findUnique({
          where: { id: beauticianId },
          include: { subscription: true },
        }),
        prisma.servicePackage.findMany({
          where: { beauticianId, isActive: true },
          orderBy: [{ serviceType: 'asc' }, { name: 'asc' }],
        }),
        req.user?.userId
          ? prisma.user.findUnique({
              where: { id: req.user.userId },
              select: { id: true, phone: true, role: true },
            })
          : Promise.resolve(null),
      ]);

      if (!beautician) {
        res.status(404).json({ success: false, error: { message: 'Studio not found' } });
        return;
      }

      res.status(200).json({
        success: true,
        user,
        beautician,
        packages: packages.map((p) => ({
          ...p,
          pricePaise: Number(p.pricePaise),
        })),
      });
    } catch (error) {
      logger.error({ error }, 'Fetch /auth/me failed');
      res.status(500).json({ success: false, error: { message: 'Internal server error' } });
    }
  }

  /**
   * PATCH /api/v1/auth/me
   * Update the authenticated user's studio profile
   */
  static async updateMe(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const { ownerName, businessName, businessTypes, city, address, pincode, phone, logoUri } = req.body || {};

      const updated = await prisma.beautician.update({
        where: { id: beauticianId },
        data: {
          ...(ownerName !== undefined ? { ownerName: String(ownerName).trim() } : {}),
          ...(businessName !== undefined ? { businessName: String(businessName).trim() } : {}),
          ...(Array.isArray(businessTypes) ? { businessTypes } : {}),
          ...(city !== undefined ? { city: String(city).trim() } : {}),
          ...(address !== undefined ? { address: String(address).trim() } : {}),
          ...(pincode !== undefined ? { pincode: String(pincode).trim() } : {}),
          ...(phone !== undefined ? { phone: String(phone).trim() } : {}),
          ...(logoUri !== undefined ? { profilePhotoUrl: logoUri } : {}),
        },
      });

      res.status(200).json({ success: true, beautician: updated });
    } catch (error) {
      logger.error({ error }, 'Update beautician profile failed');
      res.status(500).json({ success: false, error: { message: 'Failed to update profile' } });
    }
  }

  /**
   * DELETE /api/v1/auth/account
   * Permanently delete the authenticated user's beautician studio and account
   */
  static async deleteAccount(req: Request, res: Response): Promise<void> {
    try {
      const beauticianId = req.beauticianId!;
      const userId = req.user?.userId;
      const { reason, feedback } = req.body || {};

      logger.warn({ beauticianId, userId, reason, feedback }, 'User requested permanent account deletion');

      // Native atomic cascade deletion with 30s timeout safety
      await prisma.$transaction(
        async (tx) => {
          // Clean up child relations and cascade delete the beautician studio
          await tx.bookingItem.deleteMany({ where: { booking: { beauticianId } } });
          await tx.payment.deleteMany({ where: { booking: { beauticianId } } });
          await tx.booking.deleteMany({ where: { beauticianId } });
          await tx.client.deleteMany({ where: { beauticianId } });
          await tx.expense.deleteMany({ where: { beauticianId } });
          await tx.galleryPhoto.deleteMany({ where: { beauticianId } });
          await tx.reminder.deleteMany({ where: { beauticianId } });
          await tx.servicePackage.deleteMany({ where: { beauticianId } });
          await tx.notification.deleteMany({ where: { beauticianId } });
          await tx.deviceToken.deleteMany({ where: { beauticianId } });
          await tx.auditLog.deleteMany({ where: { beauticianId } });
          await tx.subscription.deleteMany({ where: { beauticianId } });
          if (userId) {
            await tx.user.deleteMany({ where: { id: userId } });
          }
          await tx.beautician.deleteMany({ where: { id: beauticianId } });
        },
        { timeout: 30000, maxWait: 10000 }
      );

      res.status(200).json({
        success: true,
        message: 'Your account and all associated studio data have been permanently removed.',
      });
    } catch (error) {
      logger.error({ error }, 'Account deletion failed');
      res.status(500).json({ success: false, error: { message: 'Failed to delete account' } });
    }
  }
}
