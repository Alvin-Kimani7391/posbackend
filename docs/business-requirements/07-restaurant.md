# Restaurant and Food-Service POS (`restaurant`)

**Purpose:** restaurants, cafés, takeaways. Orders, tables and food production are central, not a retail checkout.

**Default features:** `tableManagement`, `kitchenDisplay`, `recipeManagement`, `batchTracking`.

Ingredients and finished menu items are **different kinds of item**. Menu items are sold (often with no stock of their own); ingredients are stocked and consumed by recipes.

## 1. Menu management

- Categories: food, drinks, desserts, add-ons.
- Sizes, portions, serving options.
- Modifiers (extra cheese, no onions) with price effect.
- Combos, promotions, time-limited menus.
- Order-type pricing: dine-in, takeaway, pickup, delivery.
- Availability by stock or operating hours; sold-out toggle.
- Recipe, portion quantities, authorised ingredient substitutions.
- Item cost vs selling price.

## 2. Tables and orders

- Visual floor plan, table numbering, sections.
- Occupancy and reservations; waitlist.
- Waiter assignment.
- Open orders: add items without closing the bill.
- Transfer order between tables; merge/split tables and bills.
- Split payments between customers.
- Notes, allergies, preparation instructions.
- Cancellation and void with approval.
- Timestamps and status for every order.
- Dine-in, takeaway, pickup, delivery handled as distinct order types.

## 3. Kitchen display and routing

- Send items to the correct station (grill, bar, cold, fryer).
- Queue with statuses: received, accepted, preparing, ready, served.
- Preparation-time tracking; delayed-order alerts.
- Reprint kitchen tickets with audit.
- Sold-out signalling back to waiters.
- Kitchen printer fallback when no screen.

## 4. Recipes and inventory

- Ingredient quantities per portion; yield and preparation loss.
- Automatic ingredient deduction on sale (or on kitchen send, configurable).
- Ingredient unit conversions (kg ↔ g, litre ↔ ml).
- Recipe costing and food-cost %; recipe version history.
- Ingredient batches and expiry.
- Waste, spoilage, staff meals, complimentary items recorded with reasons.
- Ingredient purchasing, receiving, low-stock alerts, suggested orders.

## 5. Payments, finance, shifts

- Cash, M-Pesa, card, split.
- Deposits (reservations), service charge, tips (allocation to staff).
- Shift management and handover.
- Delivery commissions and fees.
- Voids, discounts, comps, refunds tracked separately.

## 6. Rules and invariants

1. Selling a dish deducts configured ingredients atomically with the sale/kitchen-send; failures do not partially deduct.
2. Voiding after the kitchen started preparation records waste, not a stock return.
3. A table has at most one open bill at a time (splits create child bills).
4. Ingredient substitution requires permission if it changes cost or allergens.
5. Void/comp/discount thresholds need manager approval.
6. Recipe edits version the recipe; historical costing uses the version in force at sale.

## 7. Reports

Sales by table, waiter, menu item, order type; food cost, gross and contribution margin; voids, discounts, comps, refunds; preparation time and delays; table turnover and average order value; waste and spoilage; ingredient valuation; cash/M-Pesa/split reconciliation; service charges and tips; delivery fees.

## 8. Dashboard and navigation

Dashboard · Tables · Orders · Kitchen · Menu · Recipes · Ingredients · Reservations · Reports.
Metrics: open orders, occupied tables, kitchen queue, food cost.

## 9. Offline

Queue orders with clear kitchen-sync status; kitchen printer continues to work; conflict-safe sync for table state.

## 10. Roles

Waiter, kitchen staff (per station), cashier, shift manager, owner. Void approvals and shift handovers.

## 11. Advanced

Reservations and waitlists; multi-branch shared menu; loyalty; online ordering and delivery-platform integration; KDS devices and receipt printers.

## 12. Example

Selling one chicken meal deducts the configured chicken, oil and other ingredients.

## 13. Current repo status

- **Exists:** core sales, payments, inventory (usable for ingredients), shifts.
- **Needs work:** everything restaurant-specific.
- **New models:** `RestaurantTable`, `MenuItem`/modifiers, `Recipe` (versioned), `KitchenOrder`, `Reservation`, `WasteRecord`.
