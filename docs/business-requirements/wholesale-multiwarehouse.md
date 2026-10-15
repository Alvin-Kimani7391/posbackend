# Wholesale + retail: multi-warehouse, unit conversion, supplier invoicing

Run once after deploy: `node scripts/migrate-multi-warehouse.js` (safe to re-run, never changes stock quantities).
Needs business features `multiWarehouse` (+ `unitConversions` for non-base units, `wholesalePricing` optional).

## Concepts
- **Stock is always in the product's BASE unit** (`Product.unit`). `Product.units[]` = bundle/carton/dozen... with `factor` (base units per 1) and optional `wholesalePrice` / `retailPrice` per unit (KES in API, cents in DB).
- **Warehouses**: many per business, any branch, one default per branch (auto-created "Main Warehouse" on first use). `allowSales=false` = storage only.
- **Sale mode** (`channel`): `RETAIL` = shop-floor stock (unchanged). `WHOLESALE` = sells a warehouse's stock at wholesale unit prices.
- **Profit** is only booked at SALE time (price - cost snapshot). A warehouse -> retail transfer moves goods at cost and books no profit.

## Endpoints (all under /api/v1)
| Method | Path | Purpose |
|---|---|---|
| GET/POST | /warehouse | list / create warehouses |
| GET/PATCH | /warehouse/:id | view / edit / set default / deactivate (must be empty) |
| POST | /warehouse/:id/adjust | opening stock, damage, correction in a unit |
| GET | /warehouse/stock?warehouseId= | stock + quantity expressed in each unit |
| GET | /warehouse/catalog?warehouseId= | **wholesale sale-dashboard feed**: products, unit prices, stock per unit |
| GET/PUT | /warehouse/settings | dashboard settings: default mode, default warehouse, payment terms, require customer |
| POST | /warehouse/transfers | move stock (see below) |
| GET | /warehouse/transfers, /transfers/:id | history |
| POST | /sales | body adds `channel`, `warehouseId`, `dueDate`, item `unitId` |
| POST | /purchases | body adds `warehouseId`, `invoiceDate`, `dueDate`, item `unitId` |
| POST | /purchases/:id/receive | body adds `warehouseId` (and per `lineLocations[].warehouseId`) |
| POST | /supplier-finance/purchases/:id/invoice | record supplier invoice total -> MATCHED / VARIANCE |
| POST | /supplier-finance/purchases/:id/invoice/approve | approve variance (`adjustPayable`) |
| POST | /supplier-finance/payments | pay supplier, allocated to invoices (oldest due first by default) |
| POST | /supplier-finance/payments/:id/void | reverse a payment |
| GET | /supplier-finance/suppliers/:supplierId/statement | running statement |
| GET | /supplier-finance/ageing | payables ageing (current, 1-30, 31-60, 61-90, 90+) |

### Transfer examples
Warehouse -> retail with unit conversion and a new retail price (price is per BASE unit, must be higher than the wholesale price; without a wholesale price, higher than cost):
```json
{ "fromLocation":"WAREHOUSE","toLocation":"RETAIL","fromWarehouseId":"...",
  "items":[{ "productId":"...","unitId":"<bundle id>","quantity":2,"retailPrice":105 }] }
```
Return to warehouse: `{"fromLocation":"RETAIL","toLocation":"WAREHOUSE","toWarehouseId":"...","items":[...]}`
Warehouse -> warehouse: both locations `WAREHOUSE` with `fromWarehouseId` and `toWarehouseId`.

### Wholesale sale example
`{ "branchId":"...","channel":"WHOLESALE","warehouseId":"...","customerId":"...","items":[{"productId":"...","unitId":"<bundle id>","quantity":10}],"payments":[],"dueDate":"2026-11-15" }`
Unpaid remainder = customer credit (needs customer + credit limit, as for retail credit sales). Cancel and refund put stock back in the SAME warehouse, in base units.

## Known limits (by design, for this release)
- Batch and serial/IMEI tracking stay pooled per branch (RETAIL pool / WAREHOUSE pool), not per individual warehouse. Serial-tracked products can only be sold in RETAIL mode (move them to retail first). Warehouse-to-warehouse moves of batch/serial products across branches are refused.
- Offline sync (offline-sale.service) is retail only.
- Manual `/inventory/adjust` and `/inventory/receive` with `location: WAREHOUSE` use the branch's default warehouse; use `/warehouse/:id/adjust` or purchases for other warehouses.
- Not tested against a live MongoDB here (the build sandbox could not download one): run `npm test` and one transfer + one wholesale sale on staging before production.
