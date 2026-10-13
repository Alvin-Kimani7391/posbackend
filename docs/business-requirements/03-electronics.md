# Electronics POS (`electronics`)

**Purpose:** phones, computers, appliances, accessories. Unit-level traceability, warranty, repairs, deposits, high-value stock controls.

**Default features:** `serialNumberTracking`, `warrantyManagement`, `repairManagement`.

## 1. Catalogue and device identity

- Brand, model, SKU, category, colour, storage capacity, specifications.
- IMEI (mobile devices) and serial numbers per unit.
- Variants and configurable attributes.
- Barcode and supplier product code.
- Purchase cost, retail price, wholesale price, minimum margin.
- Bundles, compatible accessories, optional add-ons.
- Condition: new, used, refurbished (configurable).
- Supplier, purchase invoice, goods-received records.
- Unit-level availability and physical location.

## 2. Serial numbers and warranty

- Register each serialised unit at receipt (GRN requires serials for serialised products).
- Prevent duplicate active serial/IMEI; validate IMEI format (15 digits, Luhn) where applicable.
- Link the sold unit to exact sale, customer and receipt.
- Warranty provider, terms, start date, expiry date.
- Manufacturer warranty and shop warranty tracked separately.
- Claims: record, decision, replacement unit, service outcome; eligibility check.
- Reminders before warranty expiry.
- Full traceable unit history (received → sold → returned → repaired → replaced).

## 3. Repairs and after-sales

- Intake: customer complaint, device condition, accessories received, identifiers.
- Fault, diagnosis, estimate and customer approval.
- Technician assignment, parts required, labour charge.
- Status, promised completion date, customer notification (SMS).
- Parts consumed from inventory.
- Repair invoice, deposit, balance.
- Service warranty and repeat-repair history.
- Collection confirmation; uncollected-device tracking.

## 4. Sales and finance

- Cash, M-Pesa, card, split.
- Deposits, layaway, approved instalments.
- Trade-in assessment and authorisation.
- Credit checks per shop policy.
- Refunds, exchanges, replacement devices.
- High-value transaction approvals and audit.
- Supplier warranty and return-to-supplier.

## 5. Rules and invariants

1. A serialised unit can be sold at most once while active; concurrent sale of the same serial MUST fail for one of them.
2. A sale line for a serialised product MUST reference a specific serial.
3. Returned units re-enter stock only through an inspection step.
4. Warranty start = sale date unless configured otherwise.
5. Serial and IMEI changes are audited.
6. Trade-in intake creates stock only after authorisation.

## 6. Reports

Sales and margin by model/brand; stock by serial/IMEI/condition; warranty claims; repair turnaround and profitability; accessory attach rate and bundles; stock ageing and obsolete models; supplier price comparison; deposits, instalments, balances; high-value stock reconciliation.

## 7. Dashboard

Dashboard · Checkout · Products · Serial Numbers · Warranties · Repairs · Suppliers · Reports.
Metrics: sales, warranty claims, repair jobs, serial-number stock.

## 8. Offline

Preserve serial reservations; avoid duplicate unit sales across devices; conflicts go to the offline review queue.

## 9. Roles

Cashier, sales adviser, technician, inventory clerk, manager, owner.

## 10. Example

Phone sold with IMEI recorded. Customer returns for warranty claim; the system retrieves the exact unit, sale date, warranty expiry and prior repairs.

## 11. Current repo status

- **Exists:** `SerialNumber` model, `ProductVariant`, warranty dates, `Sale`, `Purchase`.
- **Needs work:** serial enforcement on sale lines and receipt; IMEI validation; warranty claim records; repair job model/workflow; deposits/layaway/trade-in; high-value approvals; electronics reports.
- **New models:** `WarrantyClaim`, `RepairJob`, `TradeIn`, `Layaway` (proposed).
