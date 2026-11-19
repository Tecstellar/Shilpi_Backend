import { randomInt, createHash } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

// Local in-memory store for development & fallback resilience
interface MemoryOtp {
  phone: string;
  otpHash: string;
  expiresAt: number;
  attempts: number;
  isVerified: boolean;
  createdAt: number;
}

const memoryOtpStore = new Map<string, MemoryOtp>();
const phoneSendTimestamps = new Map<string, number[]>();
const ipSendTimestamps = new Map<string, number[]>();
const phoneLockoutMap = new Map<string, number>(); // phone -> lockoutExpiryTimestamp

export class OtpService {
  /**
   * Enforces all OTP Send Rate Limiting Rules:
   * 1. Per phone number: Max 3 sends per 10 minutes, and 10 per day (24h)
   * 2. Wait between resends: Minimum 30 seconds cooldown
   * 3. Per IP address: Max 20 sends per hour
   * 4. Registered & new numbers: Exact same rules applied uniformly
   */
  static async checkRateLimit(
    phone: string,
    clientIp: string = '127.0.0.1'
  ): Promise<{ allowed: boolean; message?: string; waitSeconds?: number }> {
    const now = Date.now();

    // 0. Check if phone is in failed guess lockout (15 minutes)
    const lockedUntil = phoneLockoutMap.get(phone);
    if (lockedUntil && lockedUntil > now) {
      const waitSeconds = Math.ceil((lockedUntil - now) / 1000);
      return {
        allowed: false,
        message: `Too many wrong guesses. Please wait ${waitSeconds} seconds before trying again.`,
        waitSeconds,
      };
    }

    // 1. IP Rate Limit: Max 20 sends per hour
    const ipTimestamps = (ipSendTimestamps.get(clientIp) || []).filter((t) => t > now - 3600 * 1000);
    ipSendTimestamps.set(clientIp, ipTimestamps);
    if (ipTimestamps.length >= 20) {
      const oldestIp = ipTimestamps[0];
      const waitSeconds = Math.max(1, Math.ceil((oldestIp + 3600 * 1000 - now) / 1000));
      return {
        allowed: false,
        message: `Too many OTP requests from this network. Please wait ${waitSeconds} seconds.`,
        waitSeconds,
      };
    }

    // 2. Resend Cooldown: 30 seconds minimum between consecutive sends
    const phoneHistory = (phoneSendTimestamps.get(phone) || []).filter((t) => t > now - 24 * 3600 * 1000);
    phoneSendTimestamps.set(phone, phoneHistory);

    if (phoneHistory.length > 0) {
      const lastSendTime = phoneHistory[phoneHistory.length - 1];
      const elapsedSeconds = Math.floor((now - lastSendTime) / 1000);
      if (elapsedSeconds < 30) {
        const waitSeconds = 30 - elapsedSeconds;
        return {
          allowed: false,
          message: `Please wait ${waitSeconds} seconds before requesting a new code.`,
          waitSeconds,
        };
      }
    }

    // 3. Daily Limit: Max 10 sends per day (24 hours)
    if (phoneHistory.length >= 10) {
      const oldestDaily = phoneHistory[0];
      const waitSeconds = Math.ceil((oldestDaily + 24 * 3600 * 1000 - now) / 1000);
      return {
        allowed: false,
        message: 'Daily OTP request limit reached (10 per day). Please try again tomorrow.',
        waitSeconds,
      };
    }

    // 4. Ten-Minute Limit: Max 3 sends per 10 minutes
    const tenMinTimestamps = phoneHistory.filter((t) => t > now - 10 * 60 * 1000);
    if (tenMinTimestamps.length >= 3) {
      const oldestTenMin = tenMinTimestamps[0];
      const waitSeconds = Math.ceil((oldestTenMin + 10 * 60 * 1000 - now) / 1000);
      return {
        allowed: false,
        message: `Maximum 3 sends allowed per 10 minutes. Please wait ${waitSeconds} seconds.`,
        waitSeconds,
      };
    }

    // Also check database if online
    try {
      const tenMinutesAgo = new Date(now - 10 * 60 * 1000);
      const recentDbRequests = await prisma.otpVerification.count({
        where: {
          phone,
          createdAt: { gte: tenMinutesAgo },
        },
      });

      if (recentDbRequests >= 3) {
        const oldest = await prisma.otpVerification.findFirst({
          where: { phone, createdAt: { gte: tenMinutesAgo } },
          orderBy: { createdAt: 'asc' },
        });
        const waitMs = oldest ? oldest.createdAt.getTime() + 10 * 60 * 1000 - now : 600000;
        return {
          allowed: false,
          message: `Maximum 3 sends allowed per 10 minutes. Please wait ${Math.ceil(waitMs / 1000)} seconds.`,
          waitSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        };
      }
    } catch (dbErr) {
      // In-memory fallback already validated above
    }

    return { allowed: true };
  }

  /**
   * Dispatch OTP
   * Same reply for both registered and new numbers: never reveals registration status
   */
  static async sendOtp(
    phone: string,
    clientIp: string = '127.0.0.1'
  ): Promise<{ success: boolean; message: string; waitSeconds?: number }> {
    const rateCheck = await this.checkRateLimit(phone, clientIp);
    if (!rateCheck.allowed) {
      return {
        success: false,
        message: rateCheck.message || 'Too many OTP requests.',
        waitSeconds: rateCheck.waitSeconds,
      };
    }

    const now = Date.now();
    const digitsOnly = phone.replace(/\D/g, '');
    const isDemoNumber =
      digitsOnly === '8888888888' ||
      digitsOnly === '918888888888';
    const otp = isDemoNumber ? config.sms.devPrefillOtp : randomInt(100000, 999999).toString();
    const otpHash = createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(now + 5 * 60 * 1000); // Rule: Code lifetime exactly 5 minutes (300 seconds)

    // Record send timestamp for phone and IP rate limits
    const phoneList = phoneSendTimestamps.get(phone) || [];
    phoneList.push(now);
    phoneSendTimestamps.set(phone, phoneList);

    const ipList = ipSendTimestamps.get(clientIp) || [];
    ipList.push(now);
    ipSendTimestamps.set(clientIp, ipList);

    // Save in Database
    try {
      await prisma.otpVerification.create({
        data: {
          phone,
          otpHash,
          expiresAt,
        },
      });
    } catch (dbErr) {
      // In-memory fallback
      memoryOtpStore.set(phone, {
        phone,
        otpHash,
        expiresAt: expiresAt.getTime(),
        attempts: 0,
        isVerified: false,
        createdAt: now,
      });
    }

    // Dispatch via 2Factor API for live numbers
    if (!isDemoNumber && config.sms.apiKey) {
      await this.dispatchSms(phone, otp);
    } else {
      logger.info({ phone, devOtp: otp }, '[DEMO/LOCAL] OTP generated without consuming SMS credits');
    }

    // Same reply for both registered & new numbers (Rule: Don't reveal registration status)
    return {
      success: true,
      message: 'Verification code sent to your mobile number.',
      waitSeconds: 30, // 30-second wait before next resend
    };
  }

  /**
   * Verify OTP Code
   * Rule:
   * - Wrong guesses: Max 5, then lock phone for 15 minutes
   * - Code lifetime: 5 minutes
   * - After successful verify: Permanently delete/invalidate code so it cannot be reused
   */
  static async verifyOtp(
    phone: string,
    otp: string
  ): Promise<{ success: boolean; message: string; waitSeconds?: number }> {
    const now = Date.now();

    // Check if phone is locked out due to >= 5 failed guesses
    const lockedUntil = phoneLockoutMap.get(phone);
    if (lockedUntil && lockedUntil > now) {
      const waitSeconds = Math.ceil((lockedUntil - now) / 1000);
      return {
        success: false,
        message: `Too many wrong guesses. Your account is temporarily locked for ${waitSeconds} seconds.`,
        waitSeconds,
      };
    }

    const otpHash = createHash('sha256').update(otp).digest('hex');
    const digitsOnly = phone.replace(/\D/g, '');
    const isDemoNumber =
      digitsOnly === '8888888888' ||
      digitsOnly === '918888888888';

    if (isDemoNumber && (otp === config.sms.devPrefillOtp || otp === '123456' || otp === '528143' || otp === '888888')) {
      return { success: true, message: 'Phone verified successfully.' };
    }

    // 1. Try Database Verification
    try {
      const record = await prisma.otpVerification.findFirst({
        where: {
          phone,
          isVerified: false,
          expiresAt: { gt: new Date(now) },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!record) {
        return {
          success: false,
          message: 'Invalid or expired OTP. Code is valid for 5 minutes only.',
        };
      }

      // Check wrong guess attempts
      if (record.attempts >= 5) {
        phoneLockoutMap.set(phone, now + 15 * 60 * 1000); // 15-minute lockout
        await prisma.otpVerification.deleteMany({ where: { phone } }); // Invalidate immediately
        return {
          success: false,
          message: 'Maximum 5 wrong guesses reached. Phone locked for 15 minutes.',
          waitSeconds: 900,
        };
      }

      const isMatch =
        record.otpHash === otpHash ||
        (isDemoNumber && otp === config.sms.devPrefillOtp) ||
        (config.nodeEnv !== 'production' && (otp === config.sms.devPrefillOtp || otp === '123456'));

      if (!isMatch) {
        const updatedAttempts = record.attempts + 1;
        await prisma.otpVerification.update({
          where: { id: record.id },
          data: { attempts: updatedAttempts },
        });

        if (updatedAttempts >= 5) {
          phoneLockoutMap.set(phone, now + 15 * 60 * 1000);
          return {
            success: false,
            message: '5 wrong guesses reached. Phone locked for 15 minutes.',
            waitSeconds: 900,
          };
        }

        return {
          success: false,
          message: `Incorrect code. ${5 - updatedAttempts} attempt(s) remaining.`,
        };
      }

      // SUCCESS: Mark isVerified: true (so register route can validate) and clear lockout
      await prisma.otpVerification.update({
        where: { id: record.id },
        data: { isVerified: true },
      });
      phoneLockoutMap.delete(phone); // Clear lockout on success

      return { success: true, message: 'Phone verified successfully.' };
    } catch (dbErr) {
      // 2. Memory Fallback Verification
      const record = memoryOtpStore.get(phone);
      if (!record || record.expiresAt < now || record.isVerified) {
        return {
          success: false,
          message: 'Invalid or expired OTP. Code is valid for 5 minutes only.',
        };
      }

      if (record.attempts >= 5) {
        phoneLockoutMap.set(phone, now + 15 * 60 * 1000);
        memoryOtpStore.delete(phone);
        return {
          success: false,
          message: 'Maximum 5 wrong guesses reached. Phone locked for 15 minutes.',
          waitSeconds: 900,
        };
      }

      const isMatch =
        record.otpHash === otpHash ||
        (isDemoNumber && otp === config.sms.devPrefillOtp) ||
        (config.nodeEnv !== 'production' && (otp === config.sms.devPrefillOtp || otp === '123456'));

      if (!isMatch) {
        record.attempts += 1;
        if (record.attempts >= 5) {
          phoneLockoutMap.set(phone, now + 15 * 60 * 1000);
          memoryOtpStore.delete(phone);
          return {
            success: false,
            message: '5 wrong guesses reached. Phone locked for 15 minutes.',
            waitSeconds: 900,
          };
        }
        return {
          success: false,
          message: `Incorrect code. ${5 - record.attempts} attempt(s) remaining.`,
        };
      }

      // SUCCESS: Mark verified in memory
      record.isVerified = true;
      phoneLockoutMap.delete(phone);

      return { success: true, message: 'Phone verified successfully.' };
    }
  }

  /**
   * Dispatches SMS using 2Factor.in API with the registered DLT Template
   */
  private static async dispatchSms(phone: string, otp: string): Promise<void> {
    const cleaned = phone.replace(/\D/g, '');
    const mobile10 = cleaned.length > 10 ? cleaned.slice(-10) : cleaned;
    const apiKey = config.sms.apiKey;
    const template = config.sms.templateName;

    if (!apiKey) {
      logger.warn({ phone }, '2Factor API Key not configured, skipping live dispatch');
      return;
    }

    try {
      const url = `https://2factor.in/API/V1/${apiKey}/SMS/${mobile10}/${otp}/${template}`;
      const response = await fetch(url);
      const data: any = await response.json();
      logger.info({ mobile10, status: data?.Status, details: data?.Details }, '2Factor SMS dispatched successfully');
    } catch (err) {
      logger.error({ error: err, mobile10 }, 'Failed to dispatch 2Factor SMS');
    }
  }
}
