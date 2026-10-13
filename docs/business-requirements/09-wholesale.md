# Wholesale and Distribution POS (`wholesale`)

**Purpose:** wholesalers, distributors, bulk suppliers. Larger quantities, negotiated prices, credit customers, fulfilment and delivery.

**Default features:** `wholesalePricing`, `unitConversions`, `quotationManagement`, `deliveryManagement`, `multiWarehouse`, `customerCredit`.

## 1. Customers and price lists

- Customer types: retailer, reseller, distributor, institution.
- Customer-specific price lists and contracts.
- Wholesale, trade and volume tiers; **automatic** quantity-based price rule (100 units priced differently from 10) with authorised exceptions.
- Minimum order quantities.
- Discount approvals and price-override permissions.
- Credit limits and payment terms; credit applications and documents.

## 2. Orders and fulfilment

- Quotations and sales orders; customer PO reference.
- Bulk entry and spreadsheet import.
- Partial fulfilment and backorders.
- Reservation and allocation of stock.
- Picking lists, packing lists, dispatch records.
- Delivery notes and proof of delivery.
- Returns and damaged goods.
- Order status from placement to completion; customer notifications.

## 3. Warehouse management

- Multiple warehouses and locations/bins.
- Units, packs, cartons, pallets with conversions.
- Batch, serial and expiry where relevant.
- Receiving with supplier-invoice matching.
- Picking and reservation; transfers between warehouses and branches.
- Reorder suggestions from lead time and demand.
- Cycle counts with variance approval.
- Landed-cost allocation (freight, duty).

## 4. Finance and receivables

- Customer statements and ageing.
- Partial payments allocated to invoices.
- Credit notes, debit adjustments, approved write-offs.
- Supplier balances and due dates.
- Overdue alerts, credit-limit warnings, configurable order holds.
- M-Pesa and bank reconciliation.
- Sales commissions where applicable.

## 5. Rules and invariants

1. Price resolution order: customer-specific price → customer group list → quantity tier → standard wholesale price (documented and deterministic).
2. Order exceeding credit limit or with overdue balance can be held; release requires permission.
3. Allocation reserves stock; cancellation or expiry of an order releases it.
4. Payment allocation is explicit; unallocated payments are visible as customer credit.
5. Dispatch decrements stock once; delivery status changes do not double-decrement.

## 6. Reports

Sales and margin by customer, product, salesperson; fulfilment and backorder performance; credit ageing and overdue; warehouse valuation and turnover; customer profitability after discounts and delivery; supplier performance and purchase-price changes; returns and damage rates; demand forecasting and reorder suggestions.

## 7. Dashboard

Order volume, overdue credit, pending dispatches, warehouse stock.

## 8. Offline

Preserve order reservations, credit checks and dispatch states; credit-checked actions are limited offline.

## 9. Roles

Sales rep, warehouse picker, dispatcher, accountant, credit controller, manager, owner.

## 10. Current repo status

- **Exists:** `wholesalePrice` field, purchases, inventory, customer credit/ledger.
- **Needs work:** price tiers and customer price lists, sales orders and backorders, picking/packing/dispatch, warehouse bins, ageing statements, payment allocation, credit holds.
- **New models:** `PriceList`/`PriceTier`, `SalesOrder`, `Quotation`, `DeliveryOrder`, `WarehouseLocation`, `PickList`.
