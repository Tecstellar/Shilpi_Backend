import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/shilpi_db?schema=public',
  jwt: {
    secret: process.env.JWT_SECRET || 'shilpi_super_secret_jwt_key_development_32chars_min',
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    s3Bucket: process.env.AWS_S3_MEDIA_BUCKET || 'shilpi-production-media-ap-south-1',
    cloudFrontUrl: process.env.CLOUDFRONT_URL || 'https://media.shilpiapp.com',
  },
  sms: {
    apiKey: process.env.SMS_GATEWAY_API_KEY || 'e11be203-4f77-11f1-9800-0200cd936042',
    templateName: process.env.SMS_TEMPLATE_NAME || 'Login_Verification_OTP',
    senderId: process.env.SMS_SENDER_ID || 'SHILPI',
    devPrefillOtp: process.env.SMS_DEV_PREFILL_OTP || '528143',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
};
