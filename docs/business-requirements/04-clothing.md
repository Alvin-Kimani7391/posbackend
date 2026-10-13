# Clothing and Fashion POS (`clothing`)

**Purpose:** boutiques, fashion retailers, apparel stores. The same style exists in many sizes and colours, each with its own stock.

**Default features:** `productVariants`, `loyaltyProgram`.

## 1. Product and variant management

- Product (style family): name, brand, style, collection, season, category.
- Attributes: size, colour, fabric, pattern (configurable).
- **Unique SKU/barcode per sellable variant.**
- Images and product-family grouping.
- Cost and price per variant when needed.
- Configurable size charts and size systems (S/M/L, numeric, UK/EU).
- Supplier, season, collection, status.
- New / second-hand condition where relevant.

## 2. Stock and transfers

- Inventory matrix (size × colour) per branch.
- Variant-level receiving and counting.
- Low-stock alerts by size.
- Branch transfers and balancing.
- Seasonal inventory and ageing.
- Damaged, missing, returned garments.
- Purchase planning from sales by size/colour; size-assortment purchasing.

## 3. Checkout and returns

- Barcode scanning of garment/variant.
- Item discounts, promotions, bundle deals.
- **Exchange** by size, colour or style with price difference settlement.
- Return reason and condition capture.
- Store credit or refund per policy.
- Customer history and loyalty.
- Receipt shows variant (size/colour).
- Barcode label printing.

## 4. CRM

Customer preferences and sizes (only if the customer provides them), repeat purchases, new-collection announcements, loyalty, targeted promotions, consent and opt-out.

## 5. Rules and invariants

1. Each variant has independent stock; selling M/Black never decrements L/Black.
2. A sale line must reference a variant when the product has variants.
3. Exchange = linked return + new sale with an audit link.
4. Parent product total stock = sum of variant stock (derived, not stored separately).
5. Deleting a variant with stock history is blocked (deactivate instead).

## 6. Reports

Sales by style, brand, size, colour, collection; sell-through by season; gross margin and discount performance; slow/obsolete stock; return and exchange rate; reorder by variant; profitability by collection and branch; best-selling sizes and colours.

## 7. Dashboard

Metrics: sales by size/colour, best sellers, unsold seasonal inventory.

## 8. Offline

Variant-level stock changes and concurrent sales; negative stock policy applies per variant.

## 9. Roles

Cashier, sales assistant, stock keeper, manager, owner.

## 10. Example

A black T-shirt is one product family; S, M, L, XL are separate stock lines.

## 11. Current repo status

- **Exists:** `ProductVariant` with flexible attributes, `BranchInventory`.
- **Needs work:** structured size/colour matrix API and stock grid; size systems; exchange workflow; seasonal/collection fields and sell-through reports; label printing data; size-level low-stock alerts.
