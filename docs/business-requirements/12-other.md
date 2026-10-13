# Other Business Types (`other`)

**Purpose:** businesses that fit none of the ten specialist profiles. `other` is a **configurable profile**, not a hard-coded workflow and not an empty profile. An onboarding wizard lets the owner select modules; only the chosen workflows appear.

## Configurable modules

| Module | What it supports | Needs |
|---|---|---|
| Retail checkout | Selling products, accepting payments | Core |
| Service billing | Services, labour, service packages | Service items (no stock) |
| Appointments | Booking, rescheduling, cancelling | `Appointment` model, staff calendars, reminders |
| Quotations | Estimates, approval, conversion to invoice | `Quotation` model |
| Inventory | Stock tracking, purchasing, valuation | Core inventory |
| Rentals | Asset availability, rental periods, deposits, returns | `Asset`, `Rental` models |
| Subscriptions | Recurring billing schedules and payment status | `RecurringPlan`, scheduler job |
| CRM | Profiles, history, communications | Core CRM |
| Delivery | Dispatch, tracking, proof of delivery | `Delivery` model |
| Staff management | Roles, schedules, permissions | Core + schedule model |
| Reports | Revenue, costs, outstanding, module metrics | Core |

Each module has its own configuration, permissions and data. Examples: printing shop (job estimates), furniture shop (deliveries), service business without stock.

## Requirements

- Wizard at onboarding and editable later in settings (`featureSettings`).
- Modules respect entitlements (plan) and permissions.
- Dashboard cards and navigation are generated from selected modules.
- Disabling a module hides it but **never deletes data**.
- Offline rules follow enabled modules (most restrictive applies).
- New industries start as `other`; add a subtype/profile later when there is clear demand (examples: bakery, butcher, salon, liquor shop).

## Current repo status

- **Exists:** general products, services-as-products, sales, CRM.
- **Needs work:** module selection wizard, `featureSettings` schema, appointments/rentals/subscriptions models as demand arises.
