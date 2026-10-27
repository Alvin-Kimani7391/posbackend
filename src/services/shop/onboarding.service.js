/** Shop readiness checklist (detected from real data) and starter data. */
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const BranchInventory = require('../../models/BranchInventory');
const Branch = require('../../models/Branch');
const User = require('../../models/User');
const Supplier = require('../../models/Supplier');
const Customer = require('../../models/Customer');
const Sale = require('../../models/Sale');
const CashRegister = require('../../models/CashRegister');
const IntegrationSettings = require('../../models/IntegrationSettings');
const Business = require('../../models/Business');
const AuditLog = require('../../models/AuditLog');
const { STARTER_CATEGORIES } = require('../../constants/shop');
const ApiError = require('../../utils/ApiError');

async function status(businessId) {
  const business = await Business.findById(businessId).select('businessType phone address featureSettings').lean();
  const [categories, products, withBarcode, stocked, branches, staff, suppliers, customers, sales, registers, integ] = await Promise.all([
    Category.countDocuments({ businessId, status: 'active' }),
    Product.countDocuments({ businessId, status: 'active' }),
    Product.countDocuments({ businessId, status: 'active', barcode: { $exists: true, $nin: [null, ''] } }),
    BranchInventory.countDocuments({ businessId, quantity: { $gt: 0 } }),
    Branch.countDocuments({ businessId, status: 'active' }),
    User.countDocuments({ businessId, status: 'active' }),
    Supplier.countDocuments({ businessId, status: 'active' }),
    Customer.countDocuments({ businessId }),
    Sale.countDocuments({ businessId }),
    CashRegister.countDocuments({ businessId }),
    IntegrationSettings.findOne({ businessId }).select('mpesa').lean(),
  ]);
  const mpesaOn = !!(integ && integ.mpesa && (integ.mpesa.manualEnabled || integ.mpesa.channelId));
  const steps = [
    { key: 'profile', done: !!(business && business.phone && business.address), title: 'Shop details', hint: 'Phone and address print on every receipt.' },
    { key: 'categories', done: categories >= 3, title: 'Product categories', hint: 'Use the starter list, then rename what you like.', action: 'POST /shop/onboarding/starter-categories' },
    { key: 'products', done: products >= 1, title: 'Add your products', hint: 'Type them in, scan them, or upload a spreadsheet.', action: 'POST /shop/import' },
    { key: 'stock', done: stocked >= 1, title: 'Enter opening stock', hint: 'Include a column called Opening stock in the spreadsheet, or receive stock by product.' },
    { key: 'barcodes', done: products > 0 && withBarcode / products >= 0.8, title: 'Barcodes', hint: 'Give a printed barcode to anything that has none.', action: 'POST /shop/barcodes/generate', optional: true },
    { key: 'register', done: registers >= 1, title: 'Cash register / till', hint: 'A register lets cashiers open and close shifts.' },
    { key: 'staff', done: staff >= 2, title: 'Add your cashiers', hint: 'Give each person their own login so every sale shows who made it.', optional: true },
    { key: 'payments', done: mpesaOn, title: 'Mobile money', hint: 'Connect M-PESA so payments are verified, not typed in.', optional: true },
    { key: 'suppliers', done: suppliers >= 1, title: 'Suppliers', hint: 'Needed to record purchases and what you owe.', optional: true },
    { key: 'customers', done: customers >= 1, title: 'Customers', hint: 'Add regulars to sell on credit and send offers.', optional: true },
    { key: 'firstSale', done: sales >= 1, title: 'Make a test sale', hint: 'Sell one item, print the receipt, then cancel it.' },
  ];
  const required = steps.filter((s) => !s.optional);
  return {
    businessType: business && business.businessType, ready: required.every((s) => s.done),
    percent: Math.round((steps.filter((s) => s.done).length / steps.length) * 100),
    counts: { categories, products, stockedProducts: stocked, productsWithBarcode: withBarcode, branches, staff, suppliers, customers, sales },
    steps, next: (steps.find((s) => !s.done && !s.optional) || steps.find((s) => !s.done) || null),
  };
}

function starterList(type) { return STARTER_CATEGORIES[type] || STARTER_CATEGORIES.general_shop; }

async function seedCategories(businessId, user, { names }) {
  const business = await Business.findById(businessId).select('businessType').lean();
  const list = (names && names.length ? names : starterList(business && business.businessType)).map((n) => String(n).trim()).filter(Boolean).slice(0, 40);
  if (!list.length) throw ApiError.badRequest('No category names given', 'NO_NAMES');
  const have = new Set((await Category.find({ businessId }).select('name').lean()).map((c) => c.name.toLowerCase()));
  const fresh = [...new Set(list)].filter((n) => !have.has(n.toLowerCase()));
  const created = fresh.length ? await Category.insertMany(fresh.map((name) => ({ businessId, name }))) : [];
  await AuditLog.create({ businessId, userId: user._id, action: 'category.starter_seed', entityType: 'Category', newValue: { created: created.length } });
  return { created: created.length, skippedExisting: list.length - created.length, categories: created };
}

module.exports = { status, seedCategories, starterList };
