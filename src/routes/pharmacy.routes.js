const router = require('express').Router();
const c = require('../controllers/pharmacy.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/pharmacy.validator');

router.use(authenticate, requireFeature('pharmacyDispensing'));

// ---- dashboard + reports (aggregate / compliance)
router.get('/dashboard', P('pharmacy.reports'), validate({ query: v.dashboardQuery }), c.dashboard);
router.get('/reports/dispensing', P('pharmacy.reports'), validate({ query: v.dispensingReportQuery }), c.dispensingReport);
router.get('/reports/exceptions', P('pharmacy.reports'), validate({ query: v.rangeQuery }), c.exceptionsReport);
router.get('/reports/controlled-register', P('pharmacy.reports'), validate({ query: v.registerQuery }), c.controlledRegister);
router.get('/reports/expiry', P('pharmacy.reports'), validate({ query: v.expiryQuery }), c.expiryReport);

router.get('/reports/replenishment', P('pharmacy.reports'), validate({ query: v.replenishQuery }), c.replenishment);
router.get('/reports/access', P('pharmacy.settings'), validate({ query: v.accessQuery }), c.accessReport);
router.get('/reports/retention', P('pharmacy.settings'), c.retentionReport);
router.get('/exports/dispensing', P('pharmacy.reports'), validate({ query: v.exportQuery }), c.exportDispensing);
router.get('/exports/controlled-register', P('pharmacy.reports'), validate({ query: v.registerQuery }), c.exportControlled);

// ---- suppliers (approval) and returns to supplier
router.get('/suppliers', P('medicines.manage'), c.listSuppliers);
router.put('/suppliers/:id/approval', P('medicines.manage'), validate({ params: v.idParam, body: v.approvalSchema }), c.approveSupplier);
router.post('/suppliers/:id/approval/revoke', P('medicines.manage'), validate({ params: v.idParam, body: v.reason }), c.revokeSupplier);
router.get('/supplier-returns', P('medicines.manage'), validate({ query: v.returnListQuery }), c.listReturns);
router.post('/supplier-returns', P('medicines.manage'), requireBranchAccess, validate({ body: v.supplierReturnSchema }), c.createReturn);
router.get('/supplier-returns/:id', P('medicines.manage'), validate({ params: v.idParam }), c.getReturn);
router.post('/supplier-returns/:id/credit', P('medicines.manage'), validate({ params: v.idParam, body: v.creditSchema }), c.creditReturn);

// ---- readiness, bulk set-up, class sign-off
router.get('/setup/status', P('pharmacy.settings'), c.setupStatus);
router.get('/setup/medicines-template', P('medicines.manage'), c.medicinesTemplate);
router.post('/medicines/bulk', P('medicines.manage'), validate({ body: v.bulkSchema }), c.bulkMedicines);
router.post('/settings/confirm-classes', P('pharmacy.settings'), validate({ body: v.confirmClassesSchema }), c.confirmClasses);

// ---- controlled-drug period returns (pharmacist-signed) and the Poisons Book
router.get('/controlled-returns', P('pharmacy.reports'), validate({ query: v.returnListQuery2 }), c.listControlledReturns);
router.post('/controlled-returns', P('pharmacy.restricted'), requireBranchAccess, validate({ body: v.returnGenerateSchema }), c.generateReturn);
router.get('/controlled-returns/:id', P('pharmacy.reports'), validate({ params: v.idParam }), c.getControlledReturn);
router.put('/controlled-returns/:id/counts', P('pharmacy.restricted'), validate({ params: v.idParam, body: v.returnCountsSchema }), c.countReturn);
router.post('/controlled-returns/:id/sign', P('pharmacy.restricted'), validate({ params: v.idParam, body: v.returnSignSchema }), c.signReturn);
router.get('/controlled-returns/:id/export', P('pharmacy.reports'), validate({ params: v.idParam }), c.exportReturn);
router.get('/poisons-book', P('patients.view'), validate({ query: v.poisonsQuery }), c.poisonsBook);

// ---- rules + staff credentials
router.get('/settings', P('medicines.view'), c.getSettings);
router.put('/settings', P('pharmacy.settings'), validate({ body: v.settingsSchema }), c.updateSettings);
router.get('/staff', P('pharmacy.settings'), c.listStaff);
router.put('/staff/:userId/credential', P('pharmacy.settings'), validate({ params: v.userParam, body: v.credentialSchema }), c.setCredential);
router.delete('/staff/:userId/credential', P('pharmacy.settings'), validate({ params: v.userParam }), c.revokeCredential);

// ---- medicines
router.get('/medicines', P('medicines.view'), validate({ query: v.medicineListQuery }), c.listMedicines);
router.get('/medicines/:productId', P('medicines.view'), validate({ params: v.productParam }), c.getMedicine);
router.get('/medicines/:productId/alternatives', P('medicines.view'), validate({ params: v.productParam }), c.alternatives);
router.put('/medicines/:productId', P('medicines.manage'), validate({ params: v.productParam, body: v.medicineSchema }), c.upsertMedicine);
router.post('/medicines/:productId/status', P('medicines.manage'), validate({ params: v.productParam, body: v.medicineStatusSchema }), c.setMedicineStatus);

// ---- patients (every read is audit-logged)
router.get('/patients', P('patients.view'), validate({ query: v.patientSearchQuery }), c.searchPatients);
router.post('/patients', P('patients.manage'), validate({ body: v.patientSchema }), c.createPatient);
router.get('/patients/:id', P('patients.view'), validate({ params: v.idParam }), c.getPatient);
router.get('/patients/:id/history', P('patients.view'), validate({ params: v.idParam }), c.patientHistory);
router.patch('/patients/:id', P('patients.manage'), validate({ params: v.idParam, body: v.patientUpdateSchema }), c.updatePatient);
router.post('/patients/:id/erase', P('pharmacy.settings'), validate({ params: v.idParam, body: v.reason }), c.erasePatient);

// ---- prescriptions
router.get('/prescriptions', P('prescriptions.view'), validate({ query: v.prescriptionListQuery }), c.listPrescriptions);
router.post('/prescriptions', P('prescriptions.intake'), requireBranchAccess, validate({ body: v.prescriptionSchema }), c.intake);
router.get('/prescriptions/:id', P('prescriptions.view'), validate({ params: v.idParam }), c.getPrescription);
router.post('/prescriptions/:id/review', P('prescriptions.review'), validate({ params: v.idParam, body: v.reviewSchema }), c.review);
router.post('/prescriptions/:id/interventions', P('prescriptions.review'), validate({ params: v.idParam, body: v.interventionSchema }), c.intervention);
router.post('/prescriptions/:id/cancel', P('prescriptions.intake'), validate({ params: v.idParam, body: v.reason }), c.cancelPrescription);

// ---- dispensing (the dispensing itself is a normal sale: POST /sales with prescriptionId)
router.get('/dispensings', P('prescriptions.view'), validate({ query: v.dispensingListQuery }), c.listDispensings);
router.get('/dispensings/:id', P('prescriptions.view'), validate({ params: v.idParam }), c.getDispensing);
router.post('/dispensings/:id/label', P('pharmacy.dispense'), validate({ params: v.idParam, body: v.labelSchema }), c.label);
router.post('/dispensings/:id/reverse', P('pharmacy.reverse'), validate({ params: v.idParam, body: v.reverseSchema }), c.reverse);

// ---- recalls
router.get('/recalls', P('pharmacy.recall'), validate({ query: v.recallListQuery }), c.listRecalls);
router.post('/recalls', P('pharmacy.recall'), validate({ body: v.recallSchema }), c.initiateRecall);
router.get('/recalls/:id', P('pharmacy.recall'), validate({ params: v.idParam }), c.getRecall);
router.get('/recalls/:id/trace', P('pharmacy.recall'), validate({ params: v.idParam }), c.traceRecall);
router.post('/recalls/:id/actions', P('pharmacy.recall'), validate({ params: v.idParam, body: v.recallActionSchema }), c.recallAction);
router.post('/recalls/:id/close', P('pharmacy.recall'), validate({ params: v.idParam, body: v.recallCloseSchema }), c.closeRecall);

// ---- storage / temperature
router.get('/storage', P('pharmacy.storage'), validate({ query: v.storageListQuery }), c.listStorage);
router.post('/storage', P('pharmacy.storage'), requireBranchAccess, validate({ body: v.storageLogSchema }), c.logStorage);
router.post('/storage/:id/flag', P('pharmacy.storage'), validate({ params: v.idParam, body: v.flagSchema }), c.flagStorage);
router.post('/storage/:id/assess', P('pharmacy.storage'), validate({ params: v.idParam, body: v.assessSchema }), c.assessStorage);

module.exports = router;