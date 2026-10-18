# Restaurant module (`businessType: restaurant`)

Mounted at `/api/v1/restaurant`. Built around your existing Sale / Payment / Receipt / Inventory / CashShift / M-PESA / eTIMS / CRM code.

## Install
1. Copy the files in this package into the repo (same paths).
2. `node scripts/apply-restaurant-patches.js` (dry run), then `--apply`. It edits 12 existing files with anchored, re-runnable edits and stops loudly if an anchor is missing.
3. Restaurants created from now on get the right feature flags. For existing restaurant businesses run your `scripts/migrate-feature-settings.js --apply` (it adds `restaurantOrdering` and `reservations`).
4. Add the new roles to your employee screens: SUPERVISOR, HEAD_WAITER, WAITER, CHEF, KITCHEN_STAFF, BARTENDER, EXPEDITOR, DELIVERY_RIDER. Defaults for every role are in `constants/restaurantPermissions.js`.
5. Run `npx jest tests/restaurant` (pure-logic tests: bill maths, pricing).

## Feature flags (all enforced server side)
`restaurantOrdering` (master) · `tableManagement` · `kitchenDisplay` · `recipeManagement` · `reservations`.
Café mode: with `tableManagement` off a dine-in order needs no table; with `kitchenDisplay` off sent items become READY at once (no tickets); with `recipeManagement` off nothing is deducted for RECIPE items.

## The flow
Order (waiter) -> `send` -> KOT per station -> kitchen item status (PENDING > ACCEPTED > PREPARING > READY) -> waiter `serve` -> `bills` -> `pay` -> **Sale + Receipt + eTIMS** -> order closes, table released.
An open order is never revenue. The Sale (`source: RESTAURANT`) is created in the same transaction that takes the last payment.

## Rules that are enforced
- One open dine-in order per table (atomic table claim + partial unique index).
- Prices only from the menu on the server (order type, branch, variant, happy hour, modifiers). Min/max/required option groups validated. Substitutions that change cost/allergens need `restaurant.orders.substitute`.
- Cancelling a sent item needs `restaurant.orders.void` + reason; before preparation stock returns, after preparation it is recorded as waste. Kitchen gets an amendment ticket (never a silent edit). Whole-order cancel needs no payments.
- Stock depletion event is a setting (`ON_SEND` | `ON_READY` | `ON_ORDER_CLOSE`); anything not yet deducted is deducted at close. Deduction and `item.stockState` commit in one transaction, so retries never double deduct.
- Bills carve exact integer slices (equal / by items / by seat / by amount), moving items and merging keep totals exact to the cent. Service charge is per bill; tips are separate (`TipRecord`), never revenue.
- Payments: cash (needs open shift when required), M-PESA STK/till (a code can be used once across sales, repairs, job cards and restaurant bills), card/bank, credit (permission + limit), reservation deposit. A bill is only paid when payments + credit + waived equal the total.
- Discounts limited per role (`RestaurantSettings.discounts`); waive service charge, close unpaid, comp and refund each have their own permission and audit entry.
- Waiters see only their own tables/orders unless granted `view_all`. Orders carry a `version`; send `expectedVersion` to get `ORDER_VERSION_CONFLICT` instead of overwriting.
- Offline: `POST /sync` replays queued ops (`clientRef`+`deviceId` on create, `clientItemId` per item) idempotently and reports conflicts.

## Endpoint groups
settings, areas, stations, tables (floor, combine/split, assign) · menu (groups, items, sold-out, price history, waiter `GET /menu`) · recipes (versioned, cost) · ingredients (catalogue, stock, receive, transfer, waste, adjust, counts, expiring, replenishment) · orders (create, items, send, fire course, serve, comp, transfer table, reassign, merge, request bill, assistance, cancel, reopen, delivery, pickup, sync) · kitchen (queue, item status, bump, expo, priority, reprint, stats) · bills (generate, discount, service charge, split, move items, merge, pay, close, tips, refund, void, M-PESA helpers) · reservations (+ waitlist, availability, deposits) · duty/shifts, handover, tips, incidents, waste · reports (dashboard, summary, sales by item/category/waiter/type/table/hour/day, food cost, staff, waste, stock variance, reconciliation, delivery).

## Known limits (read before go-live)
- Not run against a live MongoDB here: the transactional paths (create order, send, pay/settle, refund, stock) need an integration run on a replica set. Pure logic (bill maths, pricing) is unit tested.
- Menu items are backed by a hidden `service` Product (SKU `MENU-xxxxxx`), so they also appear in the general product list. Complimentary lines are excluded from the Sale (their cost/value stay on the bill for reports).
- Customer-credit portions are not reversed by a bill refund; refunds are limited to what was paid in cash/M-PESA/card.
- Tip payouts are recorded but do not move the cash drawer.
- Separate *orders* for guests at one table are not supported (one open order per table); use seat splits or move items between bills instead.
- Delivery-platform integrations and loyalty points beyond the existing CRM hook are not included.
