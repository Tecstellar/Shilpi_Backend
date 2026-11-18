# Shilpi Backend Service

## Overview
Enterprise Node.js and TypeScript REST API and real-time WebSocket pairing gateway powering the Shilpi Studio ERP ecosystem. Built on Express 4, Socket.io 4, Prisma ORM 6, and Amazon RDS PostgreSQL.

## Interface
- **HTTP Server**: `src/server.ts` exposes REST endpoints at `/api/v1` on port `4000` (configurable via `PORT` environment variable).
- **Real-Time Gateway**: `src/server.ts` attaches `Socket.io` to the HTTP server for real-time mobile-to-web QR session synchronization.
- **API Router**: `src/routes/v1Router.ts`
  - **Healthcheck**: `GET /healthz` -> `HealthController.check`
  - **Authentication**:
    - `POST /auth/otp/send` -> `AuthController.sendOtp`
    - `POST /auth/otp/verify` -> `AuthController.verifyOtp`
    - `POST /auth/register` -> `AuthController.register`
    - `GET /auth/me` -> `AuthController.me`
    - `PATCH /auth/me` -> `AuthController.updateMe`
    - `DELETE /auth/account` -> `AuthController.deleteAccount`
  - **Terminal QR Pairing**:
    - `POST /auth/qr/authorize` -> `QrPairingController.authorize`
  - **Dashboard Overview**:
    - `GET /dashboard/overview` -> `DashboardController.getOverview`
  - **Clients CRM**:
    - `GET /clients` -> `ClientController.list`
    - `POST /clients` -> `ClientController.create`
    - `POST /clients/import` -> `ClientController.bulkImport`
    - `PATCH /clients/:id` -> `ClientController.update`
    - `PATCH /clients/:id/vip` -> `ClientController.updateVip`
    - `PATCH /clients/:id/status` -> `ClientController.updateStatus`
  - **Bookings & Payments**:
    - `GET /bookings` -> `BookingController.list`
    - `POST /bookings` -> `BookingController.create`
    - `PATCH /bookings/:id/status` -> `BookingController.updateStatus`
    - `POST /bookings/:id/pay` -> `BookingController.recordPayment`
  - **Portfolio Gallery**:
    - `GET /gallery` -> `GalleryController.list`
    - `POST /gallery` -> `GalleryController.create`
    - `PATCH /gallery/:id` -> `GalleryController.update`
    - `DELETE /gallery/:id` -> `GalleryController.remove`
  - **Studio Expenses**:
    - `GET /expenses` -> `ExpenseController.list`
    - `POST /expenses` -> `ExpenseController.create`
    - `PATCH /expenses/:id` -> `ExpenseController.update`
    - `DELETE /expenses/:id` -> `ExpenseController.remove`
  - **Reminders**:
    - `GET /reminders` -> `ReminderController.list`
    - `POST /reminders` -> `ReminderController.create`
    - `PATCH /reminders/:id` -> `ReminderController.update`
    - `DELETE /reminders/:id` -> `ReminderController.remove`
  - **Service Packages**:
    - `GET /packages` -> `PackageController.list`
    - `POST /packages` -> `PackageController.create`
    - `PATCH /packages/:id` -> `PackageController.update`
    - `DELETE /packages/:id` -> `PackageController.remove`
- **Core Domain Services**:
  - `src/services/financialService.ts:FinancialService`: `toPaise()`, `formatRupees()`, `calculateBookingLedger()`, `calculateNetProfit()`
  - `src/services/otpService.ts:OtpService`: `sendOtp()`, `verifyOtp()`
  - `src/lib/qrPairing.ts:QrPairingManager`: `authorizeSession()`, `broadcastDataSync()` (handles `request_pairing_qr` socket events and dynamic QR DataURL generation)

## Invariants
- `[schema.prisma:BigInt]` All financial monetary columns (`total_amount_paise`, `advance_paid_paise`, `balance_due_paise`, `amount_paise`, `price_paise`, `unit_price_paise`) are strictly whole-integer `BigInt` paise ($1\text{ INR} = 100\text{ paise}$). Floating-point values for currency are strictly prohibited.
- `[authMiddleware.ts:authenticateToken]` All protected endpoints require a valid Bearer JWT header. The authenticated `beauticianId` is verified cryptographically.
- `[prisma.ts:multi_tenant]` All database reads and mutations are scoped strictly to `where: { beauticianId: req.beauticianId }` to ensure zero cross-tenant data leakage.
- `[schema.prisma:onDelete]` Deleting a client is rejected (`onDelete: Restrict`) if linked bookings exist. Account deletion cascades with an interactive transaction timeout `{ timeout: 30000, maxWait: 10000 }`.

## Side Effects
- Mutates relational state in Amazon RDS PostgreSQL across 15 schema tables.
- Broadcasts real-time authorization tokens and session events over WebSocket (`Socket.io`).
- Generates pre-signed S3 upload URLs for bridal portfolio media.

## Verification
- Run: `npm test`
