const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const medicines = require('../services/medicine.service');
const patients = require('../services/patient.service');
const prescriptions = require('../services/prescription.service');
const dispensing = require('../services/dispensing.service');
const recalls = require('../services/recall.service');
const storage = require('../services/storage.service');
const reports = require('../services/pharmacy-report.service');
const supplierSvc = require('../services/pharmacy-supplier.service');
const extras = require('../services/pharmacy-extras.service');
const setup = require('../services/pharmacy-setup.service');
const creturns = require('../services/controlled-return.service');

const ok = (res, msg, data, code = 200) => sendSuccess(res, code, msg, data);
const b = (req) => req.businessId;

// medicines + settings + staff
exports.upsertMedicine = catchAsync(async (req, res) => ok(res, 'Medicine saved', { medicine: await medicines.upsert(b(req), req.user, req.params.productId, req.body) }));
exports.getMedicine = catchAsync(async (req, res) => ok(res, 'Medicine fetched', { medicine: await medicines.get(b(req), req.params.productId) }));
exports.listMedicines = catchAsync(async (req, res) => ok(res, 'Medicines fetched', await medicines.list(b(req), req.query)));
exports.alternatives = catchAsync(async (req, res) => ok(res, 'Alternatives fetched', await medicines.alternatives(b(req), req.params.productId)));
exports.setMedicineStatus = catchAsync(async (req, res) => ok(res, 'Medicine status updated', { medicine: await medicines.setStatus(b(req), req.user, req.params.productId, req.body) }));
exports.getSettings = catchAsync(async (req, res) => ok(res, 'Settings fetched', { settings: await medicines.getSettings(b(req)) }));
exports.updateSettings = catchAsync(async (req, res) => ok(res, 'Settings updated', { settings: await medicines.updateSettings(b(req), req.user, req.body) }));
exports.listStaff = catchAsync(async (req, res) => ok(res, 'Staff fetched', await medicines.listStaff(b(req))));
exports.setCredential = catchAsync(async (req, res) => ok(res, 'Credential saved', await medicines.setCredential(b(req), req.user, req.params.userId, req.body)));
exports.revokeCredential = catchAsync(async (req, res) => ok(res, 'Credential removed', await medicines.revokeCredential(b(req), req.user, req.params.userId)));

// patients
exports.createPatient = catchAsync(async (req, res) => ok(res, 'Patient created', { patient: await patients.create(b(req), req.user, req.body) }, 201));
exports.searchPatients = catchAsync(async (req, res) => ok(res, 'Patients fetched', await patients.search(b(req), req.user, req.query)));
exports.getPatient = catchAsync(async (req, res) => ok(res, 'Patient fetched', { patient: await patients.get(b(req), req.user, req.params.id) }));
exports.patientHistory = catchAsync(async (req, res) => ok(res, 'History fetched', await patients.history(b(req), req.user, req.params.id)));
exports.updatePatient = catchAsync(async (req, res) => ok(res, 'Patient updated', { patient: await patients.update(b(req), req.user, req.params.id, req.body) }));
exports.erasePatient = catchAsync(async (req, res) => ok(res, 'Patient erased', { patient: await patients.erase(b(req), req.user, req.params.id, req.body) }));

// prescriptions
exports.intake = catchAsync(async (req, res) => ok(res, 'Prescription recorded', { prescription: await prescriptions.intake(b(req), req.body.branchId, req.user, req.body) }, 201));
exports.listPrescriptions = catchAsync(async (req, res) => ok(res, 'Prescriptions fetched', await prescriptions.list(b(req), req.user, req.query)));
exports.getPrescription = catchAsync(async (req, res) => ok(res, 'Prescription fetched', { prescription: await prescriptions.get(b(req), req.user, req.params.id) }));
exports.review = catchAsync(async (req, res) => ok(res, 'Review recorded', { prescription: await prescriptions.review(b(req), req.user, req.params.id, req.body) }));
exports.intervention = catchAsync(async (req, res) => ok(res, 'Intervention recorded', { prescription: await prescriptions.addIntervention(b(req), req.user, req.params.id, req.body) }));
exports.cancelPrescription = catchAsync(async (req, res) => ok(res, 'Prescription cancelled', { prescription: await prescriptions.cancel(b(req), req.user, req.params.id, req.body) }));

// dispensing
exports.listDispensings = catchAsync(async (req, res) => ok(res, 'Dispensings fetched', await dispensing.list(b(req), req.user, req.query)));
exports.getDispensing = catchAsync(async (req, res) => ok(res, 'Dispensing fetched', { dispensing: await dispensing.get(b(req), req.user, req.params.id) }));
exports.label = catchAsync(async (req, res) => ok(res, 'Label ready', await dispensing.label(b(req), req.user, req.params.id, req.body)));
exports.reverse = catchAsync(async (req, res) => ok(res, 'Dispensing reversed', await dispensing.reverse(b(req), req.user, req.params.id, req.body)));

// recalls
exports.initiateRecall = catchAsync(async (req, res) => ok(res, 'Recall started', await recalls.initiate(b(req), req.user, req.body), 201));
exports.listRecalls = catchAsync(async (req, res) => ok(res, 'Recalls fetched', await recalls.list(b(req), req.query)));
exports.getRecall = catchAsync(async (req, res) => ok(res, 'Recall fetched', { recall: await recalls.get(b(req), req.params.id) }));
exports.traceRecall = catchAsync(async (req, res) => ok(res, 'Trace fetched', await recalls.trace(b(req), req.user, req.params.id)));
exports.recallAction = catchAsync(async (req, res) => ok(res, 'Action recorded', { recall: await recalls.addAction(b(req), req.user, req.params.id, req.body) }));
exports.closeRecall = catchAsync(async (req, res) => ok(res, 'Recall closed', { recall: await recalls.close(b(req), req.user, req.params.id, req.body) }));

// storage
exports.logStorage = catchAsync(async (req, res) => ok(res, 'Reading recorded', { log: await storage.log(b(req), req.body.branchId, req.user, req.body) }, 201));
exports.listStorage = catchAsync(async (req, res) => ok(res, 'Readings fetched', await storage.list(b(req), req.query)));
exports.flagStorage = catchAsync(async (req, res) => ok(res, 'Batches held', { log: await storage.flagBatches(b(req), req.user, req.params.id, req.body) }));
exports.assessStorage = catchAsync(async (req, res) => ok(res, 'Exception assessed', { log: await storage.assess(b(req), req.user, req.params.id, req.body) }));

// reports
exports.dashboard = catchAsync(async (req, res) => ok(res, 'Dashboard fetched', await reports.dashboard(b(req), req.query)));
exports.dispensingReport = catchAsync(async (req, res) => ok(res, 'Report fetched', await reports.dispensingReport(b(req), req.query)));
exports.exceptionsReport = catchAsync(async (req, res) => ok(res, 'Report fetched', await reports.exceptionsReport(b(req), req.query)));
exports.controlledRegister = catchAsync(async (req, res) => ok(res, 'Register fetched', await reports.controlledRegister(b(req), req.query)));
exports.expiryReport = catchAsync(async (req, res) => ok(res, 'Expiry report fetched', await reports.expiry(b(req), req.query)));

exports.replenishment = catchAsync(async (req, res) => ok(res, 'Suggestions fetched', await extras.replenishment(b(req), req.query)));
exports.accessReport = catchAsync(async (req, res) => ok(res, 'Access report fetched', await extras.accessReport(b(req), req.query)));
exports.retentionReport = catchAsync(async (req, res) => ok(res, 'Retention report fetched', await extras.retentionReport(b(req))));
const sendCsv = (res, { filename, csv }) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); res.send(csv); };
exports.exportDispensing = catchAsync(async (req, res) => sendCsv(res, await extras.exportDispensing(b(req), req.user, req.query)));
exports.exportControlled = catchAsync(async (req, res) => sendCsv(res, await extras.exportControlled(b(req), req.user, req.query)));

// suppliers + returns
exports.listSuppliers = catchAsync(async (req, res) => ok(res, 'Suppliers fetched', await supplierSvc.listSuppliers(b(req))));
exports.approveSupplier = catchAsync(async (req, res) => ok(res, 'Supplier approved', await supplierSvc.setApproval(b(req), req.user, req.params.id, req.body)));
exports.revokeSupplier = catchAsync(async (req, res) => ok(res, 'Approval revoked', await supplierSvc.revokeApproval(b(req), req.user, req.params.id, req.body)));
exports.createReturn = catchAsync(async (req, res) => ok(res, 'Return recorded', { supplierReturn: await supplierSvc.createReturn(b(req), req.body.branchId, req.user, req.body) }, 201));
exports.listReturns = catchAsync(async (req, res) => ok(res, 'Returns fetched', await supplierSvc.listReturns(b(req), req.query)));
exports.getReturn = catchAsync(async (req, res) => ok(res, 'Return fetched', { supplierReturn: await supplierSvc.getReturn(b(req), req.params.id) }));
exports.creditReturn = catchAsync(async (req, res) => ok(res, 'Credit recorded', { supplierReturn: await supplierSvc.recordCredit(b(req), req.user, req.params.id, req.body) }));

// setup, classes, bulk
exports.confirmClasses = catchAsync(async (req, res) => ok(res, 'Classes confirmed', await medicines.confirmClasses(b(req), req.user, req.body)));
exports.setupStatus = catchAsync(async (req, res) => ok(res, 'Setup status fetched', await setup.status(b(req))));
exports.bulkMedicines = catchAsync(async (req, res) => ok(res, req.body.dryRun ? 'Checked' : 'Medicines saved', await setup.bulkImport(b(req), req.user, req.body)));
exports.medicinesTemplate = catchAsync(async (req, res) => sendCsv(res, await setup.template(b(req))));

// controlled-drug period returns + Poisons Book
exports.generateReturn = catchAsync(async (req, res) => ok(res, 'Return prepared', { controlledReturn: await creturns.generate(b(req), req.user, req.body) }, 201));
exports.listControlledReturns = catchAsync(async (req, res) => ok(res, 'Returns fetched', await creturns.list(b(req), req.query)));
exports.getControlledReturn = catchAsync(async (req, res) => ok(res, 'Return fetched', { controlledReturn: await creturns.get(b(req), req.params.id) }));
exports.countReturn = catchAsync(async (req, res) => ok(res, 'Counts saved', { controlledReturn: await creturns.recordCounts(b(req), req.user, req.params.id, req.body.counts) }));
exports.signReturn = catchAsync(async (req, res) => ok(res, 'Return signed', { controlledReturn: await creturns.sign(b(req), req.user, req.params.id, req.body) }));
exports.exportReturn = catchAsync(async (req, res) => sendCsv(res, await creturns.exportCsv(b(req), req.user, req.params.id)));
exports.poisonsBook = catchAsync(async (req, res) => ok(res, 'Poisons Book fetched', await extras.listPoisonsBook(b(req), req.user, req.query)));