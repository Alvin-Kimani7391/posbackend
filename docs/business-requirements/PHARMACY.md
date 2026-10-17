# Pharmacy module (Kenya + Tanzania)

Switch on with the `pharmacyDispensing` feature flag. Rules follow the business's country (`constants/pharmacy.js`); any rule can be overridden in `Business.pharmacySettings`.

| | Kenya (KE) | Tanzania (TZ) |
|---|---|---|
| Starting classes | OTC, Pharmacy only, Prescription only (Part I), Part I without prescription (Poisons Book), Controlled | OTC, Pharmacy supplied, Prescription medicine, Controlled |
| Prescription valid | 180 days | 7 days; 180 days with refills |
| Refills on controlled drugs | allowed unless you change it | not allowed |
| Controlled drugs per prescription | any | one |
| Patient countersigns controlled drug | no | yes (`countersign` on the sale) |
| Poisons Book | yes, for Part I poisons sold without prescription (`poisonsBook` on the sale) | not used |

These are starting points from the published law. A registered pharmacist must review the classes and each medicine's class, then call `POST /pharmacy/settings/confirm-classes`. Changing a class voids that sign-off.

## Set-up order
1. `GET /pharmacy/setup/status` - readiness checklist.
2. `GET /pharmacy/setup/medicines-template` (CSV) -> fill in -> `POST /pharmacy/medicines/bulk` (use `dryRun: true` first).
3. `PUT /pharmacy/staff/:userId/credential` for each pharmacist / dispenser (a person verifies each registration number). Role `PHARMACIST` exists; it still needs a verified credential to dispense.
4. `PUT /pharmacy/suppliers/:id/approval` with the supplier's licence; medicines can only be bought from approved suppliers.
5. Define storage places in `PUT /pharmacy/settings` (`rooms`), then confirm the classes.

## Till contract (offline)
- Download the `medicines` catalog feed (`GET /sync/catalog?type=medicines`). Each item: `productId, classification, requiresPrescription, dispenserOnly, restricted, poisonsBook, status, sellOffline`.
- Bootstrap shows `business.pharmacy` and the grant `caps.pharmacy = { requireMedicinesFeed, allowDispensing:false, allowOtc }`.
- Offline, the till must refuse any line whose product is in the feed with `sellOffline = false`, and refuse every sale if the feed was never downloaded. The server flags any offline medicine sale that slips through for review.
- Online sales carry `prescriptionId`, and where required `poisonsBook` / `countersign`; the server enforces every rule regardless of the till.

## Records
Dispensing register (`/pharmacy/dispensings`, CSV `/pharmacy/exports/dispensing`), controlled-drug register and signed period returns (`/pharmacy/controlled-returns`), Poisons Book (`/pharmacy/poisons-book`), recalls, storage logs, supplier returns. Columns are fixed and may need mapping to a template the regulator currently asks for.