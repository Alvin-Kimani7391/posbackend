# Garage and Automotive Workshop POS (`garage`)

**Purpose:** garages, repair shops, service centres. Sells parts and labour through job cards. **Not yet in `BUSINESS_TYPES`: must be added to `Business.js` and `business.validator.js`.**

**Default features:** `vehicleManagement`, `jobCards`, `quotationManagement`.

## 1. Customer and vehicle records

- Customer name and contact.
- Registration number; make, model, year, engine and other identifiers (VIN optional).
- Odometer and fuel level at intake.
- Vehicle condition and existing damage; photos/attachments.
- Customer-reported problems.
- Service and repair history.
- Next service date and mileage reminders.

## 2. Job cards and workflow

- Unique job-card number.
- Intake and inspection checklist.
- Diagnosis and recommended work.
- Labour tasks with estimated hours.
- Parts required and quantities.
- Mechanic assignment and priority; service bay.
- Estimate and customer approval (extra work needs fresh approval).
- Status: `received → diagnosed → awaiting_approval → awaiting_parts → in_progress → completed → collected`.
- Actual labour and parts used; work notes; quality-control checklist.
- Customer notifications and collection confirmation.
- Reopen a completed job with recorded reason.

## 3. Spare-parts inventory

- Part number, SKU, barcode, manufacturer.
- Vehicle compatibility and alternative parts.
- Supplier, cost, selling price.
- Stock and location.
- Reserve parts for a job card; deduct when issued; return unused to stock.
- Supplier warranty and returns.
- Reorder levels and POs.

## 4. Labour, estimates, payments

- Labour rate by task, technician or service category.
- Estimated vs actual time.
- Parts/labour breakdown on estimates and invoices.
- Approval of extra work.
- Deposits and staged payments; final invoice; balance.
- Warranty on repairs and parts.
- Customer statements; M-Pesa, cash, others.

## 5. Rules and invariants

1. Parts are deducted when **issued** to the job, not at estimate.
2. Job card totals = parts + labour + approved extras − discounts; edits after invoicing need reversal.
3. Work beyond the approved estimate requires recorded customer approval.
4. A completed job cannot be edited without reopening with reason (audited).
5. A vehicle belongs to a customer; ownership transfers are recorded.

## 6. Reports

Open/completed/overdue jobs; turnaround time; revenue and margin per job; labour utilisation and mechanic productivity; parts consumption and margin; rework and warranty claim rate; customer balances and deposits; revenue by service type, make and technician.

## 7. Dashboard

Open job cards, vehicles awaiting approval, jobs awaiting parts.
Navigation: Dashboard · Vehicles · Job Cards · Estimates · Labour · Spare Parts · Service History · Reports.

## 8. Advanced

Fleet accounts, preventive maintenance schedules, reminders by date/mileage, multiple bays, digital inspection and approvals, subcontracted services, tyre/battery serial tracking, parts and labour warranty.

## 9. Offline

Allow job-card updates; track unsynced records; parts issuing checked against stock on sync.

## 10. Roles

Mechanic, service adviser, parts clerk, cashier, manager, owner.

## 11. Example

Brake repair: job card created, parts and labour recorded, estimate approved, final invoice generated.

## 12. Current repo status

- **Exists:** products/stock/sales that can back parts and invoicing.
- **Needs work:** all garage domain models and workflows.
- **New models:** `Vehicle`, `JobCard`, `JobEstimate`, `ServiceRecord`, `WarrantyClaim`, `ServiceReminder`.
