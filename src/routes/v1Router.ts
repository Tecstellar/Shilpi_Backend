import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { QrPairingController } from '../controllers/qrPairingController.js';
import { BookingController } from '../controllers/bookingController.js';
import { ClientController } from '../controllers/clientController.js';
import { DashboardController } from '../controllers/dashboardController.js';
import { ExpenseController } from '../controllers/expenseController.js';
import { GalleryController } from '../controllers/galleryController.js';
import { HealthController } from '../controllers/healthController.js';
import { PackageController } from '../controllers/packageController.js';
import { ReminderController } from '../controllers/reminderController.js';
import { DiscoveryController } from '../controllers/discoveryController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

export const v1Router = Router();

// 1. Healthcheck (Checklist #8)
v1Router.get('/healthz', HealthController.check);

// 1.1 Public Customer Discovery: Find Nearest Beautician
v1Router.get('/discovery/beauticians', DiscoveryController.getNearestBeauticians);

// 2. Authentication & Verification
v1Router.post('/auth/otp/send', AuthController.sendOtp);
v1Router.post('/auth/otp/verify', AuthController.verifyOtp);
v1Router.post('/auth/register', AuthController.register);
v1Router.get('/auth/me', authenticateToken, AuthController.me);
v1Router.patch('/auth/me', authenticateToken, AuthController.updateMe);
v1Router.delete('/auth/account', authenticateToken, AuthController.deleteAccount);

// 3. WhatsApp-Style Web Terminal QR Pairing (Authorized by Mobile)
v1Router.post('/auth/qr/authorize', authenticateToken, QrPairingController.authorize);

// 4. Authenticated Studio Overview & Dashboard
v1Router.get('/dashboard/overview', authenticateToken, DashboardController.getOverview);

// 5. Clients CRM
v1Router.get('/clients', authenticateToken, ClientController.list);
v1Router.post('/clients', authenticateToken, ClientController.create);
v1Router.post('/clients/import', authenticateToken, ClientController.bulkImport);
v1Router.patch('/clients/:id', authenticateToken, ClientController.update);
v1Router.patch('/clients/:id/vip', authenticateToken, ClientController.updateVip);
v1Router.patch('/clients/:id/status', authenticateToken, ClientController.updateStatus);

// 6. Bookings & Orders
v1Router.get('/bookings', authenticateToken, BookingController.list);
v1Router.post('/bookings', authenticateToken, BookingController.create);
v1Router.patch('/bookings/:id/status', authenticateToken, BookingController.updateStatus);
v1Router.post('/bookings/:id/pay', authenticateToken, BookingController.recordPayment);

// 7. Portfolio Gallery (3-5 Photo Looks + Streaks)
v1Router.get('/gallery', authenticateToken, GalleryController.list);
v1Router.post('/gallery', authenticateToken, GalleryController.create);
v1Router.patch('/gallery/:id', authenticateToken, GalleryController.update);
v1Router.delete('/gallery/:id', authenticateToken, GalleryController.remove);

// 8. Studio Expenses
v1Router.get('/expenses', authenticateToken, ExpenseController.list);
v1Router.post('/expenses', authenticateToken, ExpenseController.create);
v1Router.patch('/expenses/:id', authenticateToken, ExpenseController.update);
v1Router.delete('/expenses/:id', authenticateToken, ExpenseController.remove);

// 9. Studio Reminders
v1Router.get('/reminders', authenticateToken, ReminderController.list);
v1Router.post('/reminders', authenticateToken, ReminderController.create);
v1Router.patch('/reminders/:id', authenticateToken, ReminderController.update);
v1Router.delete('/reminders/:id', authenticateToken, ReminderController.remove);

// 10. Studio Service Packages
v1Router.get('/packages', authenticateToken, PackageController.list);
v1Router.post('/packages', authenticateToken, PackageController.create);
v1Router.patch('/packages/:id', authenticateToken, PackageController.update);
v1Router.delete('/packages/:id', authenticateToken, PackageController.remove);
