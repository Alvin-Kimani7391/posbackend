# Six Star POS — Business-Type Requirements

This folder is the product and technical requirements specification for every
business type Six Star POS supports. It is the reference to build against, so
specialised modules are added without rebuilding the shared POS each time.

## Business types (11)

| Key | Document | Summary |
|---|---|---|
| `supermarket` | [02-supermarket.md](02-supermarket.md) | Fast barcode checkout, perishables, replenishment |
| `electronics` | [03-electronics.md](03-electronics.md) | Serial/IMEI traceability, warranty, repairs |
| `clothing` | [04-clothing.md](04-clothing.md) | Size/colour variant matrix, exchanges, seasons |
| `hardware` | [05-hardware.md](05-hardware.md) | Unit conversions, quotations, contractors, delivery |
| `cosmetics` | [06-cosmetics.md](06-cosmetics.md) | Shades, batches/expiry, recall traceability |
| `restaurant` | [07-restaurant.md](07-restaurant.md) | Tables, orders, kitchen, recipes, food cost |
| `general_shop` | [08-general-shop.md](08-general-shop.md) | Simple, low-friction default profile |
| `wholesale` | [09-wholesale.md](09-wholesale.md) | Price lists, orders, credit, fulfilment |
| `garage` | [10-garage.md](10-garage.md) | Vehicles, job cards, labour, spare parts |
| `pharmacy` | [11-pharmacy.md](11-pharmacy.md) | Medicine catalogue, dispensing, restricted stock |
| `other` | [12-other.md](12-other.md) | Owner-selected configurable modules |

Shared documents:

- [01-platform-core.md](01-platform-core.md): requirements that apply to **every** type
  (checkout, inventory engine, payments/M-Pesa, CRM/SMS, offline, roles, audit,
  data architecture, entitlements, roadmap).
- [13-feature-matrix.md](13-feature-matrix.md): feature flags per type, dashboards,
  offline rules, roles, and the current-code gap analysis.

## Architecture in one picture

```
Six Star POS Core
  Auth · Tenants/Branches · Sales · Payments (M-Pesa) · Receipts · Roles · Audit
Business Profile (businessType)
  supermarket · electronics · clothing · hardware · cosmetics · restaurant ·
  general_shop · wholesale · garage · pharmacy · other
Feature Modules (featureSettings)
  expiry & batches · variants · serial numbers · recipes · tables · job cards ·
  wholesale pricing · delivery · dispensing · ...
Business-specific experience
  navigation · dashboard · checkout · inventory workflow · reports · permissions
```

## Four independent decisions (enforced on the backend, never only in the UI)

1. **Business type**: which workflow and defaults apply.
2. **Feature settings**: has the owner enabled and configured the module.
3. **Subscription entitlement**: does the paid plan include the module.
4. **User permission**: may this user perform this action (refund, price override, adjust stock, dispense, ...).

A hidden menu item is not access control. Every route must check tenant
ownership, feature availability, entitlement and permission server-side.

## Document conventions

- **MUST** = required for the module to be considered correct. **SHOULD** = expected, may follow later. **MAY** = optional.
- Each business document contains: purpose, product/data requirements, workflow requirements, business rules and invariants, finance and payments, CRM, reports, dashboard, offline rules, roles, advanced features, a worked example, and **current repo status** (what exists in `src/` today vs what is missing).
- "Current repo status" was written from the code in this repository (models, validators, services). It is a first-pass audit, not a line-by-line security review.

## Findings from the first code audit (apply to all types)

1. `src/models/Business.js` and `src/validators/business.validator.js` support 9 types. **`garage` and `pharmacy` are missing** and must be added in both places.
2. `src/validators/auth.validator.js` does not accept `businessType` at registration; onboarding should let the owner choose it.
3. Purchase receiving creates batches from the purchase number rather than the supplier's real batch number and expiry per line.
4. Batch selection at sale time is not universally enforced for batch-tracked products, and branch/product/expiry validity is not verified together. FEFO is not implemented.
5. `refund.service.js` can return stock straight to sellable inventory. Pharmacy (and cosmetics/food) need quarantine or disposition before restock.
6. `package.json` has a Jest script but no test files exist yet. Establish tests (stock concurrency, tenant isolation, payments) before broad changes.
7. Existing assets to reuse, not rebuild: `Sale`, `Payment`, `Receipt`, `Product`, `ProductVariant`, `BranchInventory`, `InventoryMovement`, `Batch`, `SerialNumber`, `StockTransfer`, `Purchase`, `Supplier`, `Customer`, `CustomerLedger`, `CashShift`, `CashRegister`, `Refund`, `Expense`, `AuditLog`, `Device`, offline sync services, PayHero M-Pesa, eTIMS, CRM, SMS queue, billing.

## Suggested implementation order

1. Foundation: add `garage`/`pharmacy`, `featureSettings`, defaults per type, feature/entitlement middleware, business-specific navigation and dashboard config. Add tests.
2. Shared inventory engine: real batch receiving, expiry enforcement, FEFO, quarantine/returns, unit conversions, stock counts. Concurrency tests.
3. Retail specialisation: supermarket, cosmetics, clothing, electronics, hardware.
4. Wholesale: price lists, quotations, orders, fulfilment, credit ageing, delivery.
5. Restaurant: tables, orders, KDS, recipes, ingredient deduction.
6. Garage: vehicles, estimates, job cards, labour, parts, service history.
7. Pharmacy: validate Kenyan regulatory requirements first, then catalogue, dispensing, restricted permissions, audit reporting.
8. Other: module-selection wizard.
9. Production readiness: concurrency, tenant isolation, backups, offline recovery, payment reconciliation, data migration.
