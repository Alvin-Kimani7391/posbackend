# Kenya POS Backend

Multi-tenant SaaS Point of Sale backend for Kenyan retail businesses.
Node.js + Express + MongoDB (Mongoose).

## Status: Phase 1 of 9 complete

This is being built in modular phases rather than all at once, per the
project's own architecture rules (never dump business logic into routes,
never generate the whole app blindly).

### Phase 1 — Foundation (done)
- Project structure (`routes -> controllers -> services -> models`)
- Config loading + MongoDB connection with graceful shutdown
- `Business`, `User`, `Branch`, `AuditLog` models
- Role/permission system (6 roles, granular permission strings, per-user
  grant/revoke overrides on top of role defaults)
- JWT auth: register, login (password + employee PIN), refresh, logout,
  forgot/reset/change password
- Core middleware: `authenticate`, `authorizeRole`, `requirePermission`,
  `requireBranchAccess` — every protected route enforces these server-side;
  `businessId` is **always** derived from the authenticated user, never from
  request params/body/query
- Branch CRUD (soft delete only — main branch cannot be deleted)
- Employee CRUD (soft delete/deactivate only, PIN or password login)
- Centralized error handling with consistent `{ success, message, code,
  errors }` response shape, structured logging, request IDs
- Security baseline: Helmet, CORS, rate limiting on auth endpoints,
  NoSQL-injection sanitization, bcrypt password/PIN hashing, no secrets ever
  returned in API responses
- `/health` endpoint, `render.yaml`, `.env.example`

### Not yet built (next phases)
2. Products, variants, categories
3. Inventory engine (movements, branch inventory, stock receiving, transfers, batches/serials/expiry)
4. Sales engine + cash registers/shifts (atomic, backend-priced, snapshot-based)
5. Payments (unified model, split payments, M-PESA STK/callback, card/bank abstraction), customer credit ledger
6. Suppliers, purchases, expenses, refunds, returns
7. Reports, profit calculation, dashboard, audit log viewing
8. M-PESA + eTIMS integration modules, offline sync, devices, notifications, background jobs
9. Tests, seed data, OpenAPI docs

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT secrets, etc.
npm run dev
```

## Auth flow

1. `POST /api/v1/auth/register` — creates a Business + its Main Branch + an
   OWNER user in one transaction.
2. `POST /api/v1/auth/login` — email/phone + password → access + refresh token.
3. `POST /api/v1/auth/pin-login` — businessId + employeeCode + PIN, for cashiers.
4. `POST /api/v1/auth/refresh` — exchange refresh token for a new pair.
5. All protected routes: `Authorization: Bearer <accessToken>`.

## Multi-tenancy rule (enforced everywhere)

`req.businessId` is set once, in `authenticate` middleware, from the JWT's
verified user record — never trust a `businessId` in the request. Every
service function takes `businessId` as an explicit first argument and scopes
every query with it.
