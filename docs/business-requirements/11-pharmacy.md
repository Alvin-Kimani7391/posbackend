# Pharmacy POS (`pharmacy`)

**Purpose:** pharmacies and medicine-dispensing businesses. **Not yet in `BUSINESS_TYPES`: must be added to `Business.js` and `business.validator.js`.**

A pharmacy is **not** a general shop with a "medicine" category. It needs medicine identification, batch/expiry control, prescription workflows where applicable, dispensing records, restricted-product permissions and regulatory reporting.

> **Compliance notice.** Before deployment in Kenya, validate pharmacy workflows, controlled-product rules, records retention, tax treatment and reporting against current requirements of the **Pharmacy and Poisons Board (PPB)**, relevant Kenyan law (including data-protection law) and other authorities. Rules MUST be configurable, not hard-coded from assumptions. Installing a feature does not make a pharmacy legally compliant, and the software must not imply it does.

**Default features:** `expiryTracking`, `batchTracking` (mandatory), plus dedicated dispensing controls.

## 1. Medicine master catalogue

Structured data, not just a product name:

- Brand name and generic/active ingredient.
- Strength and dosage form (tablet, capsule, syrup, cream, injection).
- Pack size, manufacturer.
- Registration/authorisation details as applicable.
- Barcode, SKU, supplier code.
- Batch-tracking requirement.
- Storage instructions and temperature requirements.
- Prescription classification and restricted-product flags.
- Product information references where appropriate.
- Cost, price, tax category, permitted unit of sale (e.g. tablet vs strip).
- Alternative brands/generics with clinically appropriate matching.
- Status: `active`, `discontinued`, `recalled`, `quarantined`.

Catalogue MUST distinguish medicines with similar names but different strength, dosage form or active ingredient.

## 2. Batch, expiry and stock control

- Record batch, expiry, supplier, receipt date at GRN (the supplier's real batch/expiry per line).
- Quantity per batch.
- **FEFO** allocation.
- Expiry warnings at configurable intervals.
- **Block dispensing/sale of expired or quarantined stock** (server-enforced).
- Record recalled batches and affected inventory.
- Quarantine and authorised release.
- Damaged, missing, expired, returned tracking.
- Supplier returns with batch traceability.
- Stock counts and controlled adjustments; valuation; purchase-price history.
- Low-stock alerts and replenishment suggestions.
- Temperature/storage logs where required; storage exceptions flag stock for quarantine pending a responsible person's assessment.
- Restricted access to adjustments and write-offs.

## 3. Dispensing and prescription workflow

- Prescription intake and reference.
- Patient identity and minimum necessary information.
- Prescriber details and prescription date.
- Medicine, strength, form, prescribed quantity, directions.
- Validation and pharmacist review.
- Authorised dispenser identity.
- Dispensed quantity; remaining quantity where repeat dispensing is legally permitted; partial dispensing and completion status.
- Clinical checks and allergy information where appropriately collected.
- Record interventions, clarifications, authorised changes.
- Dispensing label and patient instructions; reprint with audit.
- Each dispensing links to the sale and the stock batch.
- Traceable history with a correction process.

**Safety:** the system MUST NOT diagnose, recommend prescription changes or authorise restricted medicines. That is for qualified professionals under legally required checks.

## 4. Prescription and restricted-product controls

- Configurable classification per current regulation.
- Separate permissions: ordinary sale, prescription dispensing, restricted products.
- Required professional review and authorisation.
- Prescription validity and required-field checks.
- Recordkeeping per requirements.
- Configurable quantity, repeat and documentation restrictions.
- Controlled-product registers where legally required; restricted stock counts and discrepancy escalation.
- Refusal/cancellation records.
- Audit of overrides, corrections and decisions.
- Role restrictions: cashier, assistant, dispenser, pharmacist.

## 5. Checkout and billing

- Retail and dispensing workflows are separate.
- Prescription validated before a prescription sale completes.
- Itemised medicine and non-medicine lines.
- Batch-level stock deduction.
- Cash, M-Pesa, card, split, approved credit where appropriate.
- Receipts with privacy safeguards (no clinical detail beyond what is necessary).
- Returns/refunds with medicine-specific restrictions.
- **Returned medicine never auto-returns to sellable stock**: record disposal, quarantine or authorised return-to-stock.
- Reconciliation; reversed/corrected dispensing with audit trail.

## 6. Patient profiles and privacy

- Identification appropriate to workflow; contact details only when needed and lawful.
- Prescription and dispensing history with access restrictions; allergy/clinical info only where appropriate.
- **Record-access audit logs.**
- Consent and lawful-basis handling; retention, correction and secure deletion per law.
- Secure backups and controlled exports.
- **No** use of medicine history for indiscriminate marketing. CRM/SMS and ordinary sales reports MUST NOT expose medicines, diagnoses or prescription history.

## 7. Suppliers and procurement

Approved suppliers and credentials; POs and GRNs; invoice and price history; batch/expiry/quantity verification on receipt; supplier returns and credit notes; recall notices and affected-batch tracing; lead times and alerts; purchase approval; records required for regulated procurement.

## 8. Reports and compliance

Stock by medicine, batch, expiry; expiring/expired/recalled/quarantined; dispensing volumes and sales; discrepancies and controlled-product reconciliation; purchase and supplier reports; margin and sales summaries (access-controlled); prescription exceptions and authorisation audit; professional activity and dispensing records; regulatory exports where supported and required; recall traceability and affected-transaction lookup; retention and audit-access reports.

## 9. Hardware and integrations

Barcode scanners, label printers, receipt printers, workstations/tablets, optional temperature monitoring, secure auth and sessions, backup/recovery.

## 10. Offline

Do not assume every general offline function is safe for dispensing. Prescription checks, restricted rules, batch availability and authorisation may need online validation or a deliberately limited offline procedure. Default: **dispensing blocked offline**; over-the-counter sale of non-restricted, in-date stock may be allowed if enabled.

## 11. Dashboard

Today's sales and dispensing activity; expiring/expired stock; low/out-of-stock medicines; quarantined/recalled batches; pending prescription reviews; discrepancies; POs awaiting receipt; restricted-product reconciliation tasks. Aggregate figures only, with no patient-level clinical detail on the general dashboard.

## 12. Roles

Pharmacist, authorised dispenser, pharmacy assistant, cashier, inventory clerk, purchasing officer, manager, owner. Pharmacist/dispenser permissions are distinct permission strings.

## 13. Rules and invariants

1. Sale of an expired, recalled or quarantined batch is impossible server-side.
2. Restricted/prescription items cannot be sold without a validated prescription and an authorised dispenser.
3. Every dispensing record links: prescription, patient, dispenser, sale, batch(es), quantity.
4. Dispensing corrections are reversals with reason, never edits.
5. Returned medicines go to quarantine/disposal by default.
6. Patient data access is permissioned and logged.

## 14. Current repo status

- **Exists:** basic product, `Batch`, expiry fields, inventory.
- **Needs work (blocking for pharmacy):** add `pharmacy` type; real supplier batch capture on receipt; enforced batch selection + FEFO + expiry/quarantine block at sale; fix `refund.service.js` auto-restock; pharmacy permissions in `constants/permissions.js`; dispensing and prescription models; record-access auditing; recall workflow; restricted offline policy.
- **New models:** `PharmacyProductDetails`/`MedicineDetails`, `Prescription`, `DispensingRecord`, `StockQuarantine`, `RecallRecord`, `StorageLog`.
