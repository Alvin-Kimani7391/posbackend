# Feature Matrix, Defaults and Gap Analysis

## 1. Feature flags (`featureSettings`)

```js
const FEATURE_KEYS = [
  'expiryTracking', 'batchTracking', 'productVariants', 'serialNumberTracking',
  'warrantyManagement', 'repairManagement', 'unitConversions', 'quotationManagement',
  'deliveryManagement', 'customerCredit', 'loyaltyProgram', 'tableManagement',
  'kitchenDisplay', 'recipeManagement', 'vehicleManagement', 'jobCards',
  'wholesalePricing', 'multiWarehouse',
  // add for pharmacy:
  'pharmacyDispensing', 'prescriptionManagement', 'restrictedProductControl',
  'recallManagement', 'quarantineManagement',
];
```

Flags only configure behaviour. Each needs real models, APIs, permissions and tests behind it.

## 2. Defaults by business type

| Feature | super­market | elec­tronics | cloth­ing | hard­ware | cosm­etics | rest­aurant | general | whole­sale | garage | pharm­acy | other |
|---|---|---|---|---|---|---|---|---|---|---|---|
| expiryTracking | ✔ | | | | ✔ | | | | | ✔ | |
| batchTracking | ✔ | | | | ✔ | ✔ | | | | ✔ | |
| productVariants | | | ✔ | | ✔ | | | | | | |
| serialNumberTracking | | ✔ | | | | | | | | | |
| warrantyManagement | | ✔ | | | | | | | | | |
| repairManagement | | ✔ | | | | | | | | | |
| unitConversions | ✔ | | | ✔ | | | | ✔ | | | |
| quotationManagement | | | | ✔ | | | | ✔ | ✔ | | |
| deliveryManagement | | | | ✔ | | | | ✔ | | | |
| customerCredit | | | | | | | | ✔ | | | |
| loyaltyProgram | ✔ | | ✔ | | ✔ | | | | | | |
| tableManagement | | | | | | ✔ | | | | | |
| kitchenDisplay | | | | | | ✔ | | | | | |
| recipeManagement | | | | | | ✔ | | | | | |
| vehicleManagement | | | | | | | | | ✔ | | |
| jobCards | | | | | | | | | ✔ | | |
| wholesalePricing | | | | | | | | ✔ | | | |
| multiWarehouse | | | | | | | | ✔ | | | |
| pharmacy dispensing/restricted/recall/quarantine | | | | | | | | | | ✔ | |

Owner may enable compatible extra modules later. When `businessType` changes, preserve compatible existing settings instead of overwriting.

## 3. Navigation and dashboard by type

| Type | Navigation | Dashboard metrics |
|---|---|---|
| supermarket | Dashboard · Checkout · Products · Expiring Stock · Purchases · Suppliers · Cashiers · Reports | Sales, low stock, near-expiry, cashier variance |
| electronics | Dashboard · Checkout · Products · Serial Numbers · Warranties · Repairs · Suppliers · Reports | Sales, warranty claims, repair jobs, serial stock |
| clothing | Dashboard · Checkout · Products · Variant Stock · Exchanges · Collections · Reports | Sales by size/colour, best sellers, unsold seasonal |
| hardware | Dashboard · Checkout · Products · Quotations · Deliveries · Contractors · Reports | Availability, contractor balances, pending deliveries |
| cosmetics | Dashboard · Checkout · Products · Batches · Customers · Reports | Expiring batches, popular shades, repeat customers |
| restaurant | Dashboard · Tables · Orders · Kitchen · Menu · Recipes · Ingredients · Reservations · Reports | Open orders, occupied tables, kitchen queue, food cost |
| general_shop | Dashboard · Checkout · Products · Customers · Expenses · Reports | Sales, stock alerts, expenses, est. profit |
| wholesale | Dashboard · Orders · Customers · Price Lists · Warehouse · Dispatch · Credit · Reports | Order volume, overdue credit, pending dispatch, stock |
| garage | Dashboard · Vehicles · Job Cards · Estimates · Labour · Spare Parts · Service History · Reports | Open jobs, awaiting approval, awaiting parts |
| pharmacy | Dashboard · Checkout · Dispensing · Medicines · Expiry & Recalls · Purchases · Compliance · Reports | Dispensing activity, expiring, quarantined, pending reviews |
| other | Generated from selected modules | Per module |

## 4. Roles by type

| Type | Extra roles |
|---|---|
| supermarket | cashier, supervisor, inventory clerk, purchasing officer |
| electronics | sales adviser, technician |
| clothing | sales assistant, stock keeper |
| hardware | sales rep, storekeeper, dispatcher, driver |
| cosmetics | beauty adviser |
| restaurant | waiter, kitchen staff, shift manager |
| general_shop | cashier |
| wholesale | sales rep, picker, dispatcher, credit controller, accountant |
| garage | mechanic, service adviser, parts clerk |
| pharmacy | pharmacist, authorised dispenser, assistant |

## 5. Gap analysis against the current repo

| Type | Existing foundation | Main work still needed |
|---|---|---|
| supermarket | products, barcodes, inventory, purchases, sales, shifts, Batch | FEFO and expiry-aware selling, promotions, stocktakes, shrinkage, replenishment reports |
| electronics | variants, SerialNumber, warranty dates | claims, repairs, IMEI validation, deposits, layaway, trade-ins |
| clothing | variants (flexible attributes) | size/colour matrix, exchanges, seasonal analysis |
| hardware | basic units | conversions, fractions, contractor pricing, quotations, projects, delivery |
| cosmetics | variants, batches, expiry | shade attributes, enforced expiry selling, recall, preferences |
| restaurant | core sales and inventory | tables, orders, modifiers, kitchen, recipes, deductions, food cost |
| general_shop | strong foundation | simpler UI, optional modules, import, onboarding |
| wholesale | `wholesalePrice`, purchases, inventory | tiers, price lists, orders, backorders, picking, delivery |
| garage | product/stock/sales | vehicles, job cards, estimates, labour, parts usage, history |
| pharmacy | product, batch, expiry, inventory | medicine catalogue, dispensing, prescriptions, restricted controls, recall, quarantine, privacy |
| other | products and services | module wizard, appointments/rentals/subscriptions |

## 6. Cross-cutting fixes to do first

| File | Change |
|---|---|
| `src/models/Business.js` | Add `garage`, `pharmacy`; add `featureSettings`, `industrySettings`, `businessSubtype`, `featureEntitlements` |
| `src/validators/business.validator.js` | Update enum and validate new config |
| `src/validators/auth.validator.js` | Accept `businessType` at registration |
| `src/services/auth.service.js` | Apply type defaults on business creation |
| `src/services/business.service.js` | Safe merge/validation of feature settings |
| `src/constants/permissions.js` | Add specialist permissions (dispense, restricted product, job card, kitchen, ...) |
| `src/middleware/subscriptionGate.js` | Add feature/entitlement check middleware (`requireFeature`) |
| `src/services/purchase.service.js` | Capture supplier batch number and expiry per received line |
| `src/services/sale.service.js` | Enforce batch selection, FEFO, expiry/quarantine block, serial selection |
| `src/services/refund.service.js` | Disposition (restock / quarantine / dispose) instead of automatic restock |
| `src/services/inventory.service.js` | Unit conversion, stocktake and variance approval |
| tests | Create Jest suites (none exist today): tenant isolation, stock concurrency, payment idempotency, refunds, offline replay |

Migrations must preserve existing businesses' settings and data.
