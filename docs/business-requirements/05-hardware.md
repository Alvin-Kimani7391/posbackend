# Hardware and Building Materials POS (`hardware`)

**Purpose:** hardware shops and building-material suppliers. Multiple units, bulky stock, contractors, quotations, deliveries.

**Default features:** `unitConversions`, `quotationManagement`, `deliveryManagement`.

## 1. Product and unit management

- Product code, manufacturer, brand, specification, category.
- Units: piece, metre, m², m³, kg, litre, bag, packet, box, tonne (configurable).
- Purchase unit vs selling unit with **per-product** conversion factor.
- Products sold by length, area, volume or weight.
- Bulk, contractor and quantity-break pricing.
- Compatible and alternative products.
- Supplier codes, technical descriptions, dimensions, weight.

**Example:** a 100 m cable roll is bought as one roll and sold by the metre. The ledger tracks remaining length; unusable remnants are written off with a reason. A box of 20 tiles sold as single tiles keeps correct remaining boxes and tiles. Not every boxed product is divisible: divisibility is a product setting.

## 2. Stock and warehouse

- Warehouse, rack, shelf, bin locations.
- Bulk receiving, partial deliveries.
- Reservation for approved orders.
- Transfers and delivery allocation.
- Stock counts, adjustments.
- Lead times, reorder levels.
- Damaged material and scrap.
- Batch/lot where useful (paint, cement).
- Heavy/special-handling flags.

## 3. Quotations, contractors, projects

- Quotations with validity period.
- Contractor-specific prices and discounts.
- Convert approved quotation to sales order, then invoice.
- Customer PO and reference numbers.
- Project-based customer records and order history.
- Partial fulfilment, backorders.
- Pro forma and tax invoices.
- Credit limits and payment terms.
- Delivery charges, delivery notes, proof of delivery.
- Returns of unused material per policy.

## 4. Delivery

Schedule, vehicle and driver assignment, status (pending, loaded, in transit, delivered, failed), proof of delivery (signature/photo/OTP), delivery cost per order.

## 5. Rules and invariants

1. Stock is held in a base unit; every sale/purchase converts via the product's factor, rounding rules defined per unit.
2. Fractional quantities allowed only for units flagged measurable.
3. Quotation does not reserve stock until approved (configurable); expiry releases reservations.
4. Credit sale blocked when credit limit exceeded unless approved.
5. Quotation → sale conversion keeps price lock unless re-priced with approval.

## 6. Reports

Sales and margin by product and unit; profitability by contractor/project; stock ageing and slow materials; supplier price changes; pending deliveries; credit balances and overdue invoices; stock valuation and warehouse reconciliation; delivery cost and order profitability.

## 7. Dashboard

Stock availability, contractor balances, pending deliveries.

## 8. Offline

Preserve unit conversions, quotations and quantities; quotations editable offline, conversion to sale checked on sync.

## 9. Roles

Cashier, sales rep, storekeeper, dispatcher, driver, manager, owner.

## 10. Current repo status

- **Exists:** basic units (kg, g, litre, ml, metre, box, packet), `wholesalePrice`, purchases, inventory.
- **Needs work:** unit conversion engine, fractional quantity handling, contractor/tier pricing, quotation model and conversion, project orders, delivery model, warehouse locations.
- **New models:** `Quotation`, `DeliveryOrder`, `UnitConversion` (or product-level conversion), `WarehouseLocation`, `PriceTier`.
