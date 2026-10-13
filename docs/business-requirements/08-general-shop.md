# General Shop POS (`general_shop`)

**Purpose:** small Kenyan shops selling mixed everyday goods. The easiest profile to learn. It is also the default for businesses that cannot be assigned confidently to another type.

**Default features:** none enabled by default. Owner can opt in to expiry, variants, units, loyalty.

## 1. Product management

- Add by hand or barcode; categories, units, prices.
- Cost price, selling price, margin estimate.
- Optional image and description.
- Simple stock quantity and minimum level.
- Optional variants, expiry, batches.

## 2. Daily operations

- Fast checkout, simple cart.
- Cash and M-Pesa; manual M-Pesa reference with controlled verification.
- Receipts and invoices.
- Credit sales when authorised; customer balances and payments against balances.
- Purchases and supplier records.
- Returns, refunds, manager approval.
- Daily cash reconciliation and expenses.

## 3. CRM and reports

- Customer contacts and history.
- SMS promotions with consent and opt-out.
- Daily/weekly/monthly sales; profit estimate; stock value.
- Top sellers, low-stock warnings.
- Expense tracking, cashier performance.
- Outstanding customer credit and supplier balances.

## 4. Usability requirements (design rules)

- Minimal clicks at checkout; large touch targets.
- Barcode scanner and receipt printer support.
- Clear errors and payment status.
- Guided onboarding; product import from spreadsheet.
- Simple offline mode with recovery.
- **Do not show** recipe costing, repair, vehicle or other specialist features unless that module is enabled.

## 5. Dashboard

Sales, stock alerts, expenses, estimated profit.

## 6. Offline

Basic checkout and payment reconciliation.

## 7. Roles

Owner, cashier, optional manager.

## 8. Current repo status

- **Exists:** strong general retail foundation (this is what the current POS is).
- **Needs work:** spreadsheet product import, guided onboarding, optional-module toggles via `featureSettings`, simplified navigation.
