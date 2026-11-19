import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const beauticians = await prisma.beautician.findMany();
  console.log('BEAUTICIANS IN DB (' + beauticians.length + '):');
  console.log(JSON.stringify(beauticians, null, 2));

  const users = await prisma.user.findMany();
  console.log('USERS IN DB (' + users.length + '):');
  console.log(JSON.stringify(users, null, 2));

  const bookingsCount = await prisma.booking.count();
  const clientsCount = await prisma.client.count();
  const expensesCount = await prisma.expense.count();
  const otpsCount = await prisma.otpVerification.count();

  console.log('COUNTS:', {
    bookingsCount,
    clientsCount,
    expensesCount,
    otpsCount,
  });
}

main()
  .catch((e) => {
    console.error('Inspect error:', e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
