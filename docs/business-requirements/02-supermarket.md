# Supermarket POS (`supermarket`)

**Purpose:** supermarkets, mini-supermarkets and grocery retailers. High transaction volume, many SKUs, multiple cashiers, frequent replenishment, perishables.

**Default features:** `expiryTracking`, `batchTracking`, `unitConversions`, `loyaltyProgram`.

## 1. Product management

- Name, SKU, barcode (multiple barcodes allowed), brand, category/subcategory.
- Unit of measure: piece, packet, carton, kg, litre, etc.; pack sizes and conversions.
- Purchase cost, selling price, wholesale price, minimum selling price.
- Tax category; price tax-inclusive or not.
- Image, description, supplier associations.
- Variable-weight products with price-per-weight (scale integration optional).
- Bundles and promotional combinations.
- Discontinued products and replacement products.

## 2. Inventory and perishables

- Stock by branch, warehouse and storage location.
- GRN with supplier-invoice matching.
- Batch/lot numbers and expiry dates where applicable.
- **FEFO** allocation (first-expiring, first-out) for perishables; FIFO otherwise.
- Near-expiry alerts with configurable thresholds.
- Damaged, expired, missing and returned stock tracking.
- Stock counts, recounts, variance approval, stocktake history.
- Low-stock alerts and reorder suggestions using supplier lead time.
- Inter-branch transfers and reconciliation; central warehouse replenishment.
- Negative stock prevented, controlled override only.
- Stock valuation and movement history.

## 3. Checkout and cashier operations

- Fast barcode scanning, keyboard-driven checkout, quantity shortcuts.
- Search by name, SKU or barcode.
- Suspend / resume / cancel sales (audited).
- Line discounts and authorised price overrides.
- Cash, M-Pesa, card, split payment, approved credit; M-Pesa reference matching.
- Returns, exchanges, voids, manager-approved refunds.
- Cash drawer: opening float, cash drops, closing count; shift variance reports.
- Receipt reprint with traceability.
- Offline checkout with controlled pending queue.
- Multiple tills; branch-specific price rules.

## 4. Purchasing and suppliers

- Supplier contacts, payment terms.
- Purchase requisitions and POs; partial deliveries and backorders.
- Received vs ordered quantity comparison.
- Purchase invoice recording; supplier returns.
- Supplier price history with price-change alerts.
- Outstanding supplier balances and due dates.

## 5. Pricing and promotions

- Bulk price updates, promotional pricing with start/end, quantity discounts.
- Vouchers, loyalty points, campaigns.
- Approval workflows for discounts, refunds and stock adjustments.

## 6. Rules and invariants

1. A batch-tracked product MUST NOT be sold without allocating a valid batch (same business, same branch, same product, not expired, not quarantined).
2. Expired stock MUST be blocked at checkout and moved via an explicit "expired write-off" movement.
3. Sale line records the batch sold.
4. Stock and batch decrement are atomic and concurrency-safe.
5. Refunds of perishables do not return to sellable stock automatically.
6. Price override and discount above cashier limit require approval.

## 7. Reports

- Hourly/daily/weekly/monthly sales; sales and margin by product, category, branch, cashier.
- Best-selling and slow-moving, dead stock.
- Near-expiry and expiry losses.
- Shrinkage and adjustment analysis.
- Reorder requirements, supplier performance.
- Gross profit, expenses, estimated net profit, cash reconciliation.
- Customer frequency, basket value, promotion performance.

## 8. Dashboard and navigation

Dashboard · Checkout · Products · Expiring Stock · Purchases · Suppliers · Cashiers · Reports.
Metrics: today's sales, low stock, items nearing expiry, cashier variances.

## 9. Offline

Queue pending sales; synchronise stock changes safely; reject sync of sales against batches that expired or were depleted in the meantime into a review queue (`offline-review`).

## 10. Roles

Cashier, supervisor, inventory clerk, purchasing officer, branch manager, owner, accountant.

## 11. Advanced

Multiple branches, central warehouse, loyalty/vouchers, scales, label printers, cash drawers, receipt printers, CRM/SMS integration.

## 12. Example

Twenty cartons of milk approach expiry: the system warns, suggests markdown or return-to-supplier, and flags products below reorder level before they run out.

## 13. Current repo status

- **Exists:** `Product`, barcodes, `BranchInventory`, `InventoryMovement`, `Batch`, `Purchase`, `Supplier`, `CashShift`, `CashRegister`, `Sale`, `Payment`, offline sync, `StockTransfer`, customer credit.
- **Needs work:** real supplier batch/expiry capture on purchase receipt; enforced batch selection and FEFO at sale; expiry alerts/reports; promotions engine; stocktake workflow with variance approval; suspend/resume sales; reorder recommendations; shrinkage reports.
