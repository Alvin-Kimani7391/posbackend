# Platform Core — Requirements for Every Business Type

Every business type inherits this foundation. Industry modules extend it and
must not duplicate it.

## 1. Sales and checkout

- Product search, barcode scanning, quick-sale shortcuts, cart editing.
- Discounts (line and sale level) with role-limited maximums (see `settings.maxCashierDiscountPercent`, `maxManagerDiscountPercent`).
- Configurable tax (inclusive/exclusive, default rate, per-product tax category), VAT registration, KRA PIN on receipts, eTIMS submission with retry.
- Payments: cash, M-Pesa STK Push, manual M-Pesa reference, card, bank, approved customer credit, split payments.
- Receipts and invoices with configurable prefix, header/footer, logo, paper width (58mm/80mm), custom lines, SMS/WhatsApp/email delivery.
- Returns, exchanges, voids and manager-approved refunds.
- Suspend/resume/cancel sale with audit.
- **Pricing is computed on the server.** The client never dictates final price, tax or total.

## 2. Inventory and procurement

- SKU and barcode management (multiple barcodes per product).
- Stock movements are an append-only ledger (`InventoryMovement`): sale, purchase, return, adjustment, transfer, damage, expiry, recall, production/consumption.
- Stock counts with recount and variance approval, stock valuation, reorder levels and suggestions.
- Supplier records, purchase orders, goods received notes (GRN), landed cost, supplier invoices, returns to supplier, supplier balances.
- Branch and warehouse stock, inter-branch transfers with approval and reconciliation.
- Damaged, expired, missing stock handled by explicit statuses and movements.

### Inventory engine product kinds

The engine MUST support these without adding unrelated fields to every product:

| Kind | Example | Extra validation |
|---|---|---|
| Simple | Bottle of soap | none |
| Variant-based | T-shirt M/Black | variant attributes, SKU per variant |
| Batch/expiry | Milk, medicine | batch number + expiry on receipt, FEFO on sale |
| Serialised | Phone | unique serial/IMEI per unit |
| Measured / variable-weight | Cable by metre, loose rice | fractional quantity, unit conversion |
| Ingredient / recipe component | Cooking oil | consumed by recipes |
| Service | Labour, haircut | no physical stock |
| Composite / bundle | Combo, kit | expands to components |

Rules:

- Different product kinds use different validation (IMEI required for a phone, not for flour).
- Quantities are tracked per business, branch, product, variant and (where relevant) batch.
- Stock changes and batch changes happen atomically in one DB transaction (`utils/withTx.js`).
- Negative stock is blocked unless `settings.allowNegativeStock` is on and the actor is authorised.
- Configurable units and conversion factors **per product** (not every boxed product is divisible).

## 3. Payment engine and M-Pesa

- STK Push initiation and status polling; secure callback verification.
- **Idempotent callbacks**: a repeated callback must never create a duplicate payment (`IdempotencyKey`, `MpesaTransaction`).
- Manual M-Pesa reference entry with controlled matching (`MpesaInboundPayment`, `OfflineMpesaClaim`).
- Partial and split payments; allocation of one payment across invoices.
- Statuses: `pending`, `successful`, `failed`, `cancelled`, `reversed`.
- **A pending payment is never confirmed revenue** until reliable confirmation.
- Offline manual M-Pesa entry is a claim, not proof that money arrived.
- Reversal and refund records, outstanding balance management, reconciliation reports (cash, M-Pesa, bank, card).

## 4. Customers, CRM and SMS

- Customer profiles, purchase history, credit limits, statements (`CustomerLedger`), loyalty, groups/segments.
- Campaigns, scheduling, sender ID per business, SMS credits and consumption, segment/character cost calculation, delivery reports, failed message handling.
- Opt-in/opt-out and consent are stored **separately** from payment. Paying by M-Pesa is not consent to marketing.
- Campaign approval and audit logs; tenant-level usage and billing reconciliation.

## 5. Finance and reporting

- Revenue, discounts, COGS, gross profit, operating expenses, estimated net profit.
- Customer receivables, supplier payables, payment reconciliation.
- Cash drawer opening float, cash drops, closing count, variance (`CashShift`, `CashRegister`, `CashierShortage`).
- Reports clearly separate: revenue, gross profit, expenses, cash received, credit sales, outstanding balances.
- Closed sales are corrected by reversal/adjustment entries, never silently overwritten.

## 6. Multi-tenant and branch architecture

- Every document carries `businessId` and, where applicable, `branchId`.
- `businessId` is derived from the authenticated user, **never** from request body/params/query.
- One shop can never read or write another shop's customers, stock, payments, job cards, prescriptions, etc.
- Roles scoped to a business and optionally a branch (`requireBranchAccess`).
- Centralised products with branch-specific price and stock where required.
- Secure onboarding, suspension and closure; controlled exports and retention.

## 7. Offline operation and synchronisation

- Pending-sale queue with limits (`settings.offline.*`: max hours, max pending sales and value, shared vs dedicated device mode).
- Visible sync status, conflict handling, recovery process, duplicate-safe replay (idempotency).
- Offline credit, card, refunds and manual M-Pesa are **off by default** and individually enabled.

| Type | Offline considerations |
|---|---|
| supermarket | Queue sales; sync stock safely |
| electronics | Preserve serial reservations; avoid duplicate unit sales |
| clothing | Variant-level stock; concurrent sales |
| hardware | Preserve unit conversions, quotations, quantities |
| cosmetics | Never sell expired/quarantined batches |
| restaurant | Queue orders with visible kitchen sync status |
| general_shop | Basic checkout and payment reconciliation |
| wholesale | Preserve reservations, credit checks, dispatch states |
| garage | Allow job-card updates; track unsynced records |
| pharmacy | Restrict dispensing when prescription/batch/authorisation checks cannot run |
| other | Rules follow enabled modules |

## 8. Access control and audit

Recommended roles (configurable, not hard-coded): owner, administrator, branch manager, supervisor, cashier, inventory clerk, purchasing officer, accountant, pharmacist/authorised dispenser, waiter, kitchen staff, mechanic, service adviser, warehouse picker, dispatcher.

- Permissions control **actions** (issue refund, change price, adjust stock, dispense restricted medicine), not just screens.
- Sensitive actions record actor, time, business, branch, affected record, reason, before/after values.
- Passwords, API secrets and payment credentials never appear in audit logs.
- Manager approval workflows for refunds, voids, discounts above limit, stock adjustments, price overrides.

## 9. Data architecture

`Business` stays the identity/configuration model. Operational data lives in its own collections.

| Model | Responsibility |
|---|---|
| Business | Identity, `businessType`, settings, subscription |
| Branch | Outlets and branch settings |
| User / membership | Login identity; access to business and branch |
| Product, ProductVariant | Shared catalogue |
| BranchInventory / InventoryBalance | Current stock per location and tracking dimension |
| InventoryMovement / StockMovement | Auditable ledger |
| Batch / InventoryBatch | Batch and expiry |
| SerialNumber | Serialised units |
| Sale, Payment, Receipt, Refund | Sales and money |
| Purchase / PurchaseOrder, GoodsReceivedNote, Supplier | Procurement |
| Customer, CustomerLedger | Customers and credit |
| Expense, AuditLog | Costs and audit |
| FeatureEntitlement | Plan-to-module entitlements |
| Industry models | Recipe, KitchenOrder, RestaurantTable, Vehicle, JobCard, Quotation, Delivery, Prescription, DispensingRecord, PharmacyProductDetails, PriceList, ... |

Business model additions:

| Field | Purpose |
|---|---|
| `businessType` | Primary profile (add `garage`, `pharmacy`) |
| `businessSubtype` | Optional: mini-supermarket, café, bakery, salon, liquor shop |
| `featureSettings` | Validated feature booleans (see matrix) |
| `industrySettings` | Validated sub-schema per industry (not one giant object) |
| `branchSettings` | Branch operating rules |
| `featureEntitlements` | Paid modules included in the plan |

Do **not** store patient records, serial histories, recipes or job cards inside `industrySettings`.

A feature flag never replaces the data model. `serialNumberTracking: true` still needs `SerialNumber` records and integrity checks; the pharmacy module needs real `Prescription` and `DispensingRecord` collections, not `pharmacy: true`.

## 10. Entitlements

Before a module operates, check: business profile → feature enabled → plan entitlement → user permission. This lets you sell a basic POS and charge for multi-branch, advanced analytics, kitchen management, wholesale distribution, etc.

## 11. Non-functional requirements

- Transactions for any multi-document stock/money change.
- Concurrency-safe stock decrement (no overselling under parallel sales).
- Idempotency keys on sale creation, payment callbacks, sync replay.
- Rate limiting, input validation (zod), NoSQL-injection sanitisation (already present).
- Backups, restore drills, data export, retention policy.
- Automated tests: tenant isolation, stock concurrency, payment idempotency, refund/restock, offline replay, permission checks.
