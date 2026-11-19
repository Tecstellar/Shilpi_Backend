import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('--- STARTING COMPLETE TEST DATA CLEANUP ---');

  // Delete all dependent child records first, then parents
  const deletedAudit = await prisma.auditLog.deleteMany({});
  console.log(`Deleted ${deletedAudit.count} audit logs.`);

  const deletedNotifs = await prisma.notification.deleteMany({});
  console.log(`Deleted ${deletedNotifs.count} notifications.`);

  const deletedTokens = await prisma.deviceToken.deleteMany({});
  console.log(`Deleted ${deletedTokens.count} device tokens.`);

  const deletedReminders = await prisma.reminder.deleteMany({});
  console.log(`Deleted ${deletedReminders.count} reminders.`);

  const deletedPhotos = await prisma.galleryPhoto.deleteMany({});
  console.log(`Deleted ${deletedPhotos.count} gallery photos.`);

  const deletedPayments = await prisma.payment.deleteMany({});
  console.log(`Deleted ${deletedPayments.count} payments.`);

  const deletedBookingItems = await prisma.bookingItem.deleteMany({});
  console.log(`Deleted ${deletedBookingItems.count} booking items.`);

  const deletedBookings = await prisma.booking.deleteMany({});
  console.log(`Deleted ${deletedBookings.count} bookings.`);

  const deletedExpenses = await prisma.expense.deleteMany({});
  console.log(`Deleted ${deletedExpenses.count} expenses.`);

  const deletedPackages = await prisma.servicePackage.deleteMany({});
  console.log(`Deleted ${deletedPackages.count} service packages.`);

  const deletedClients = await prisma.client.deleteMany({});
  console.log(`Deleted ${deletedClients.count} clients.`);

  const deletedSubscriptions = await prisma.subscription.deleteMany({});
  console.log(`Deleted ${deletedSubscriptions.count} subscriptions.`);

  const deletedUsers = await prisma.user.deleteMany({});
  console.log(`Deleted ${deletedUsers.count} users.`);

  const deletedBeauticians = await prisma.beautician.deleteMany({});
  console.log(`Deleted ${deletedBeauticians.count} beauticians.`);

  const deletedOtps = await prisma.otpVerification.deleteMany({});
  console.log(`Deleted ${deletedOtps.count} OTP records.`);

  console.log('--- ALL TEST DATA DELETED SUCCESSFULLY. DATABASE IS NOW CLEAN ---');
}

main()
  .catch((e) => {
    console.error('Clean database error:', e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
