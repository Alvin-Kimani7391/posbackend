# Cosmetics and Beauty POS (`cosmetics`)

**Purpose:** cosmetics, skincare, fragrance and beauty-supply retailers. Shades, batches, expiry, hygiene-based return rules.

**Default features:** `expiryTracking`, `batchTracking`, `productVariants`, `loyaltyProgram`.

## 1. Catalogue and variants

- Brand, product line, SKU, barcode.
- Variants: foundation shade, lipstick colour, fragrance, volume, skincare variant.
- Shade code and swatch where available.
- Pack sizes and bundles.
- Images, ingredients, manufacturer info.
- Cost, selling price, promotional price.
- Supplier records and batch-level traceability.

## 2. Batch and expiry

- Batch/lot number and expiry date on receipt.
- FEFO rotation.
- Near-expiry warnings with thresholds.
- **Quarantine** for damaged, recalled or expired products.
- Supplier return workflow.
- Batch-level cost and remaining quantity.
- **Recall traceability:** identify affected batches, remaining stock, and which sales included them.
- Controlled disposal records for expired products.

## 3. Sales and customer experience

- Barcode scanning with variant selection.
- Bundles and promotions.
- Customer preferences and shade history, with privacy controls.
- Loyalty and repeat-purchase rewards.
- Returns/exchanges honouring hygiene policy (opened products not restocked).
- Targeted promotions and new-product notifications; SMS and receipt integration.

## 4. Rules and invariants

1. Each shade is a separate variant with its own stock.
2. Batch-tracked variant MUST have a valid, unexpired, non-quarantined batch to be sold.
3. Returned opened items never return to sellable stock automatically.
4. Recall action moves affected batch stock to quarantine and logs affected sales.
5. Marketing uses consented contacts only.

## 5. Reports

Sales by brand, shade, product line, variant; margin by product; expiry losses and ageing; fast/slow movers; repeat-purchase patterns; promotion performance; reorder by shade and supplier.

## 6. Dashboard

Expiring batches, popular shades, repeat customers.

## 7. Offline

Prevent sale of expired/quarantined batches; sync re-validates batch status, conflicts go to review.

## 8. Roles

Cashier, beauty adviser, stock keeper, manager, owner.

## 9. Example

Foundation shade 1 and shade 2 tracked separately; the owner is warned when a batch nears expiry.

## 10. Current repo status

- **Exists:** `ProductVariant`, `Batch`, expiry fields, batch flags on products.
- **Needs work:** structured shade/size variant attributes, enforced batch selection and FEFO at sale, expiry-aware selling, quarantine and recall records, return disposition, customer product preferences.
- **New models:** `StockQuarantine`, `RecallRecord` (shared with pharmacy).
