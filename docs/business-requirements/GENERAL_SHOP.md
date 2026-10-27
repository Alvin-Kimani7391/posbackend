# General shop tools (`/api/v1/shop`)

Available to every business type unless noted. Money is decimal in/out (cents inside).

| Area | Endpoints | Permission |
|---|---|---|
| Set-up checklist | GET `/onboarding`, POST `/onboarding/starter-categories` | shop.onboarding.manage |
| Product import | GET `/import/template`, POST `/import` (JSON csv/rows), POST `/import/file` (multipart `file`), GET `/export` | shop.import |
| Held sales (feature `heldSales`) | GET/POST `/held`, POST `/held/:id/recall`, DELETE `/held/:id` | shop.held.use (manage = see all) |
| Promotions (feature `promotions`) | GET `/promotions/active`, POST `/promotions/quote`, CRUD `/promotions`, pause / resume | shop.promotions.view / manage |
| Bulk prices | POST `/prices/preview`, `/prices/apply`, GET `/prices/history`, POST `/prices/history/:id/revert` | shop.prices.manage |
| Barcodes | POST `/barcodes/generate`, `/barcodes/labels` | shop.barcodes.manage |
| Reports | GET `/reports/end-of-day`, `margins`, `dead-stock`, `stock-valuation`, `reorder`, `credit-aging`, `customer-statement/:id` | shop.reports.view |

## Rules
- **Import:** always `dryRun: true` first. Rows are independent; re-running a file is safe (existing SKU/barcode is skipped, or updated in `UPSERT` mode). Opening stock only goes onto NEW products and needs `branchId`. Excel: Save As CSV, or have the app send parsed `rows`. Max 2000 rows per call.
- **Held sales:** nothing is reserved. Recall hands the cart back once, with today's prices and stock warnings; carts expire after 24 h; 20 per cashier.
- **Promotions:** the best single offer per line (no stacking). `quote` returns a suggested line discount; the till sends it as the normal line discount (the sale still needs `sales.create`; the server does not auto-apply offers inside `POST /sales`).
- **Bulk prices:** preview, then apply. Selling below cost needs `allowBelowCost`. Revert only restores products not edited since. Products with variants are skipped.
- **Barcodes:** internal EAN-13 starting with 2. The frontend draws the barcode from the label data.
- **Reports:** end-of-day uses the business time zone; cash figure is an estimate (the shift close is authoritative). Credit aging applies payments to the oldest debt first.

## After deploying
Run `node scripts/migrate-feature-settings.js --apply` so existing shops get `heldSales` / `promotions` defaults. Not run against MongoDB; pure logic is covered by `tests/shop`.
