
/**
 * seed-staging-demo.js
 *
 * Run from the POS backend root:
 *   node scripts/seed-staging-demo.js
 *   node scripts/seed-staging-demo.js --reset
 *
 * Environment:
 *   MONGODB_URI / MONGO_URI / DATABASE_URL
 *   MIGRATION_DB_NAME (must contain "staging")
 *   NODE_ENV=staging
 *   MPESA_ENVIRONMENT=sandbox
 *   DEMO_PASSWORD (minimum 12 characters)
 *
 * Operation:
 *   Creates a realistic DEMO shop in the STAGING database:
 *   - Owner, manager and cashier accounts
 *   - Categories and approximately 36 products
 *   - Opening stock
 *   - Demo customers with credit limits
 *   - Approximately 6 weeks of backdated sales
 *
 * Safety:
 *   Refuses to run outside staging.
 *   Refuses non-sandbox M-Pesa environments.
 *   Uses fake customer data and does not initiate real payments.
 *
 * --reset deletes ONLY the existing demo business and its
 * business-associated records before rebuilding it.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// --------------------------------------------------
// COMMAND-LINE ARGUMENTS
// --------------------------------------------------

const args = process.argv.slice(2);

const RESET = args.includes('--reset');

const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// --------------------------------------------------
// DEMO CONFIGURATION
// --------------------------------------------------

const DEMO_NAME = 'Mama Njeri Mini Mart (DEMO)';

const OWNER_EMAIL = 'owner@demo.sixstar.test';

const PEOPLE = {
  owner: {
    name: 'Njeri Wanjiku (Demo Owner)',
    phone: '0700000101',
    email: OWNER_EMAIL
  },

  manager: {
    name: 'Peter Otieno (Demo Manager)',
    phone: '0700000102',
    email: 'manager@demo.sixstar.test',
    role: 'MANAGER',
    employeeCode: 'MGR01'
  },

  cashier: {
    name: 'Amina Hassan (Demo Cashier)',
    phone: '0700000103',
    email: 'cashier@demo.sixstar.test',
    role: 'CASHIER',
    employeeCode: 'CSH01'
  }
};

const DAYS = 42;

// --------------------------------------------------
// DATABASE CONFIGURATION
// --------------------------------------------------

function dbNameOf(uri) {
  const match = String(uri || '').match(
    /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?]+\/([^?]*)/i
  );

  return match ? decodeURIComponent(match[1]) : '';
}

// --------------------------------------------------
// SAFETY VALIDATION
// --------------------------------------------------

function validateEnvironment(uri, dbName) {
  const problems = [];

  if (!uri) {
    problems.push(
      'MongoDB URI is missing. Set MONGODB_URI, MONGO_URI, or DATABASE_URL.'
    );
  }

  if (process.env.NODE_ENV !== 'staging') {
    problems.push('NODE_ENV must be "staging".');
  }

  if (!/staging/i.test(dbName)) {
    problems.push(
      `Database name "${dbName || '(empty)'}" does not contain "staging".`
    );
  }

  if ((process.env.MPESA_ENVIRONMENT || '') !== 'sandbox') {
    problems.push('MPESA_ENVIRONMENT must be "sandbox".');
  }

  const password = process.env.DEMO_PASSWORD || '';

  if (password.length < 12) {
    problems.push('Set DEMO_PASSWORD to at least 12 characters.');
  }

  if (problems.length > 0) {
    throw new Error(
      'REFUSING TO SEED:\n - ' + problems.join('\n - ')
    );
  }

  return password;
}

// --------------------------------------------------
// DETERMINISTIC RANDOM DATA
// --------------------------------------------------

let seed = 20261110;

const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;

  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pick = (array) =>
  array[Math.floor(rnd() * array.length)];

const between = (a, b) =>
  a + Math.floor(rnd() * (b - a + 1));

const kes = (amount) => Math.round(amount * 100);

// --------------------------------------------------
// PRODUCT CATALOGUE
// name, category, cost KES, selling price KES
// --------------------------------------------------

const CATALOG = [
  ['Jogoo Maize Flour 2kg', 'Groceries', 150, 185],
  ['Pembe Maize Flour 2kg', 'Groceries', 148, 182],
  ['Exe Wheat Flour 2kg', 'Groceries', 160, 195],
  ['Mumias Sugar 1kg', 'Groceries', 150, 180],
  ['Kabras Sugar 2kg', 'Groceries', 290, 340],
  ['Pishori Rice 1kg', 'Groceries', 170, 210],
  ['Tuzo Cooking Oil 1L', 'Groceries', 250, 310],
  ['Elianto Cooking Oil 3L', 'Groceries', 720, 850],
  ['Salt Kensalt 500g', 'Groceries', 25, 40],
  ['Spaghetti Santa Lucia 400g', 'Groceries', 70, 95],
  ['Tomato Paste Zesta 70g', 'Groceries', 30, 45],
  ['Eggs Tray (30)', 'Groceries', 420, 480],

  ['Fresh Milk Brookside 500ml', 'Beverages', 52, 65],
  ['Fresh Milk Brookside 1L', 'Beverages', 98, 120],
  ['Ketepa Tea Leaves 100g', 'Beverages', 70, 95],
  ['Nescafe Classic 50g', 'Beverages', 210, 260],
  ['Coca-Cola 500ml', 'Beverages', 42, 60],
  ['Fanta Orange 500ml', 'Beverages', 42, 60],
  ['Dasani Water 1L', 'Beverages', 45, 70],
  ['Minute Maid Mango 1L', 'Beverages', 105, 140],

  ['Omo Detergent 1kg', 'Household', 230, 290],
  ['Sunlight Soap Bar 200g', 'Household', 38, 55],
  ['Jik Bleach 750ml', 'Household', 115, 150],
  ['Toilet Paper Rolls (4)', 'Household', 95, 130],
  ['Matchbox (10 pack)', 'Household', 25, 40],
  ['Kitchen Sponge (3 pack)', 'Household', 40, 65],

  ['Geisha Soap 175g', 'Personal Care', 55, 80],
  ['Colgate Toothpaste 100ml', 'Personal Care', 110, 150],
  ['Vaseline Petroleum Jelly 250ml', 'Personal Care', 190, 250],
  ['Always Sanitary Pads (8)', 'Personal Care', 85, 120],
  ['Dettol Soap 175g', 'Personal Care', 75, 105],

  ['Digestive Biscuits 400g', 'Snacks', 95, 130],
  ['Crisps Kenchic 50g', 'Snacks', 30, 50],
  ['Bread Supaloaf 400g', 'Snacks', 52, 65],
  ['Mandazi Mix 500g', 'Snacks', 70, 100],

  ['Exercise Book 96pg', 'Stationery', 30, 50],
  ['Pen Bic Blue (single)', 'Stationery', 8, 20]
];

// --------------------------------------------------
// DEMO CUSTOMERS
// name, phone, credit limit KES
// --------------------------------------------------

const CUSTOMERS = [
  ['Grace Mutheu', '0700100001', 20000],
  ['John Kamau', '0700100002', 30000],
  ['Fatuma Ali', '0700100003', 15000],
  ['Brian Kiplagat', '0700100004', 0],
  ['Lucy Achieng', '0700100005', 0],
  ['Samuel Mwangi', '0700100006', 25000],
  ['Esther Wairimu', '0700100007', 0],
  ['Hassan Omar', '0700100008', 0],
  ['Mary Atieno', '0700100009', 0],
  ['David Kiprop', '0700100010', 0]
];

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL;

  // Explicit database override takes priority.
  // Unlike other migration scripts, this script MUST use staging.
  const dbName =
    process.env.MIGRATION_DB_NAME || dbNameOf(uri);

  const PASSWORD = validateEnvironment(uri, dbName);

  let connected = false;

  try {
    await mongoose.connect(uri, { dbName });

    connected = true;

    console.log(
      `Connected to database "${mongoose.connection.name}"`
    );

    console.log('Environment: STAGING');
    console.log('M-Pesa environment: SANDBOX');
    console.log(`Mode: ${RESET ? 'RESET + SEED' : 'SEED'}`);

    const db = mongoose.connection.db;

    if (!db) {
      throw new Error('MongoDB database connection is unavailable.');
    }

    // --------------------------------------------------
    // LOAD MODELS
    // --------------------------------------------------

    const modelsDirectory = path.join(
      __dirname,
      '../src/models'
    );

    fs.readdirSync(modelsDirectory)
      .filter((file) => file.endsWith('.js'))
      .forEach((file) => {
        try {
          require(path.join(modelsDirectory, file));
        } catch (error) {
          console.warn(
            `Optional model skipped: ${file} - ${error.message}`
          );
        }
      });

    const Business = require('../src/models/Business');
    const User = require('../src/models/User');
    const Sale = require('../src/models/Sale');
    const Payment = require('../src/models/Payment');
    const InventoryMovement = require('../src/models/InventoryMovement');

    // --------------------------------------------------
    // LOAD APPLICATION SERVICES
    // --------------------------------------------------

    const authSvc = require('../src/services/auth.service');
    const employeeSvc = require('../src/services/employee.service');
    const categorySvc = require('../src/services/category.service');
    const productSvc = require('../src/services/product.service');
    const customerSvc = require('../src/services/customer.service');
    const inventorySvc = require('../src/services/inventory.service');
    const saleSvc = require('../src/services/sale.service');

    const id = (document) =>
      (document &&
        (document.product ||
          document.customer ||
          document.category ||
          document))._id;

    // --------------------------------------------------
    // CHECK EXISTING DEMO BUSINESS
    // --------------------------------------------------

    const existing = await Business.findOne({
      name: DEMO_NAME
    });

    if (existing) {
      if (!RESET) {
        console.log(
          '\nDemo shop already exists. Use --reset to rebuild it.'
        );
        return;
      }

      console.log('\n--reset: deleting ONLY the demo shop...');

      for (const name of mongoose.modelNames()) {
        const Model = mongoose.model(name);

        if (Model.schema.path('businessId')) {
          const result = await Model.deleteMany({
            businessId: existing._id
          });

          if (result.deletedCount > 0) {
            console.log(
              `  Deleted ${result.deletedCount} ${name} record(s).`
            );
          }
        }
      }

      await Business.deleteOne({
        _id: existing._id
      });

      console.log('Existing demo shop deleted.');
    }

    // --------------------------------------------------
    // CREATE BUSINESS + OWNER
    // --------------------------------------------------

    console.log('\nCreating shop + owner...');

    const { business, user: owner } =
      await authSvc.registerBusinessOwner({
        businessName: DEMO_NAME,
        businessType: 'general_shop',
        country: 'KE',
        ownerName: PEOPLE.owner.name,
        phone: PEOPLE.owner.phone,
        email: PEOPLE.owner.email,
        password: PASSWORD
      });

    const businessId = business._id;
    const branchId = owner.branchIds[0];

    await Business.updateOne(
      { _id: businessId },
      {
        $set: {
          'settings.requireShift': false,
          'settings.enableCustomerCredit': true,
          address: 'Gikomba Road, Nairobi',
          town: 'Nairobi',
          county: 'Nairobi'
        }
      }
    );

    // --------------------------------------------------
    // CREATE EMPLOYEES
    // --------------------------------------------------

    console.log('Creating manager + cashier...');

    for (const key of ['manager', 'cashier']) {
      const person = PEOPLE[key];

      await employeeSvc.createEmployee(
        businessId,
        owner._id,
        {
          name: person.name,
          phone: person.phone,
          email: person.email,
          role: person.role,
          employeeCode: person.employeeCode,
          branchIds: [branchId],
          password: PASSWORD,
          pin: key === 'cashier' ? '2468' : undefined
        }
      );
    }

    const cashier = await User.findOne({
      businessId,
      role: 'CASHIER'
    });

    // --------------------------------------------------
    // CREATE CATEGORIES + PRODUCTS + OPENING STOCK
    // --------------------------------------------------

    console.log('Creating categories + products + opening stock...');

    const categories = {};

    for (const category of [
      ...new Set(CATALOG.map((item) => item[1]))
    ]) {
      categories[category] = id(
        await categorySvc.createCategory(
          businessId,
          owner._id,
          { name: category }
        )
      );
    }

    const products = [];

    for (let i = 0; i < CATALOG.length; i++) {
      const [name, category, cost, price] = CATALOG[i];

      const product = await productSvc.createProduct(
        businessId,
        owner._id,
        {
          categoryId: categories[category],
          name,
          sku: `DEMO-${String(i + 1).padStart(3, '0')}`,
          barcode: `616100${String(1000 + i)}`,
          costPrice: kes(cost),
          sellingPrice: kes(price),
          lowStockThreshold: 10
        }
      );

      const productId = id(product);

      await inventorySvc.receiveStock(
        businessId,
        branchId,
        owner._id,
        {
          productId,
          quantity: 900,
          costPrice: kes(cost),
          reason: 'Opening stock'
        }
      );

      products.push({
        id: productId,
        name,
        price: kes(price)
      });
    }

    // --------------------------------------------------
    // CREATE CUSTOMERS
    // --------------------------------------------------

    console.log('Creating customers...');

    const customers = [];

    for (const [name, phone, limit] of CUSTOMERS) {
      const customer = await customerSvc.createCustomer(
        businessId,
        owner._id,
        { name, phone }
      );

      if (limit > 0) {
        await customerSvc.setCreditLimit(
          businessId,
          owner._id,
          id(customer),
          kes(limit)
        );
      }

      customers.push({
        id: id(customer),
        credit: limit > 0
      });
    }

    const creditCustomers = customers.filter(
      (customer) => customer.credit
    );

    // --------------------------------------------------
    // GENERATE SIX WEEKS OF BACKDATED SALES
    // --------------------------------------------------

    console.log('\nPreparing approximately 6 weeks of sales...');

    const now = Date.now();
    const NAIROBI = 3 * 3600 * 1000;

    const nairobiMidnight = (ms) =>
      Math.floor((ms + NAIROBI) / 86400000) *
        86400000 -
      NAIROBI;

    const todayStart = nairobiMidnight(now);
    const plans = [];

    for (let d = DAYS; d >= 0; d--) {
      const dayStart = todayStart - d * 86400000;

      const dayOfWeek = new Date(
        dayStart + NAIROBI
      ).getUTCDay();

      let count;

      if (dayOfWeek === 6) {
        count = between(22, 32);
      } else if (dayOfWeek === 0) {
        count = between(8, 14);
      } else if (dayOfWeek === 5) {
        count = between(18, 26);
      } else {
        count = between(12, 20);
      }

      for (let i = 0; i < count; i++) {
        const peak =
          rnd() < 0.55
            ? between(16, 19)
            : between(8, 20);

        const when =
          dayStart +
          peak * 3600000 +
          between(0, 59) * 60000 +
          between(0, 59) * 1000;

        if (when < now - 60000) {
          plans.push(when);
        }
      }
    }

    plans.sort((a, b) => a - b);

    console.log(
      `Creating ${plans.length} backdated sales...`
    );

    let ok = 0;
    let credit = 0;
    let off = 0;

    for (let n = 0; n < plans.length; n++) {
      const when = new Date(plans[n]);

      const lines = new Map();

      for (let k = between(1, 5); k > 0; k--) {
        const product = pick(products);
        const key = product.id.toString();

        lines.set(key, {
          product,
          qty: lines.has(key)
            ? lines.get(key).qty + 1
            : between(1, rnd() < 0.15 ? 6 : 3)
        });
      }

      const items = [...lines.values()].map(
        ({ product, qty }) => ({
          productId: product.id,
          quantity: qty
        })
      );

      const total = [...lines.values()].reduce(
        (sum, { product, qty }) =>
          sum + product.price * qty,
        0
      );

      const r = rnd();

      const useCredit =
        r < 0.07 && creditCustomers.length > 0;

      const customer = useCredit
        ? pick(creditCustomers)
        : rnd() < 0.30
          ? pick(customers)
          : null;

      let payments;

      if (useCredit) {
        payments =
          rnd() < 0.5
            ? []
            : [{
                method: 'CASH',
                amount: Math.round(total / 2)
              }];
      } else if (r < 0.50) {
        payments = [{
          method: 'CASH',
          amount: total
        }];
      } else if (r < 0.92) {
        payments = [{
          method: 'MOBILE_MONEY',
          provider: 'M-Pesa',
          amount: total,
          reference:
            `DEMO${Math.floor(rnd() * 1e8)
              .toString(36)
              .toUpperCase()
              .padStart(6, '0')}${n}`
        }];
      } else {
        payments = [{
          method: 'CARD',
          amount: total,
          reference: `SLIP${1000 + n}`
        }];
      }

      try {
        const result = await saleSvc.createSale(
          businessId,
          branchId,
          rnd() < 0.8 ? cashier : owner,
          {
            branchId,
            channel: 'RETAIL',
            items,
            payments,
            customerId: customer
              ? customer.id
              : undefined,
            cartDiscount: 0,
            clientTransactionId: `demo-${n}`,
            deviceId: 'demo-seed'
          }
        );

        const sale = result.sale;

        ok++;

        if (useCredit) {
          credit++;
        }

        if (sale.total !== total && !useCredit) {
          off++;
        }

        // Backdate sale timestamps.
        await Sale.updateOne(
          { _id: sale._id },
          {
            $set: {
              soldAt: when,
              createdAt: when,
              updatedAt: when
            }
          },
          { timestamps: false }
        );

        // Backdate payment timestamps.
        await Payment.updateMany(
          { saleId: sale._id },
          {
            $set: {
              createdAt: when,
              updatedAt: when
            }
          },
          { timestamps: false }
        );

        // Backdate stock movement timestamps.
        await InventoryMovement.updateMany(
          {
            referenceType: 'Sale',
            referenceId: sale._id
          },
          {
            $set: {
              createdAt: when
            }
          }
        );

      } catch (error) {
        console.warn(
          `  Sale ${n} skipped: ${error.message}`
        );
      }

      if ((n + 1) % 100 === 0) {
        console.log(
          `  Progress: ${n + 1}/${plans.length}`
        );
      }
    }

    // --------------------------------------------------
    // LEAVE SOME PRODUCTS WITH LOW STOCK
    // --------------------------------------------------

    console.log('\nLeaving a few items low on stock...');

    for (const product of products.slice(0, 5)) {
      const current = await inventorySvc.getStockLevel(
        businessId,
        branchId,
        product.id
      );

      if (current.quantity > 4) {
        await inventorySvc.adjustStock(
          businessId,
          branchId,
          owner._id,
          {
            productId: product.id,
            quantity: current.quantity - between(2, 6),
            type: 'ADJUSTMENT_OUT',
            reason: 'Stock count (demo)'
          }
        );
      }
    }

    // --------------------------------------------------
    // FINAL SUMMARY
    // --------------------------------------------------

    const aggregation = await Sale.aggregate([
      {
        $match: { businessId }
      },
      {
        $group: {
          _id: null,
          n: { $sum: 1 },
          total: { $sum: '$total' }
        }
      }
    ]);

    const summary = aggregation[0];

    console.log('\n======================================');
    console.log('       STAGING DEMO SEED COMPLETE');
    console.log('======================================');

    console.log(`Business: ${DEMO_NAME}`);
    console.log(`Business ID: ${businessId}`);
    console.log(`Database: ${mongoose.connection.name}`);

    console.log(`\nSales successfully created: ${ok}`);
    console.log(`Credit sales: ${credit}`);

    if (off > 0) {
      console.log(
        `Sales with totals different from estimate: ${off}`
      );
    }

    console.log(
      `Sales in database: ${summary ? summary.n : 0}`
    );

    console.log(
      `Total sales value: KES ${
        summary
          ? (summary.total / 100).toLocaleString()
          : 0
      }`
    );

    console.log('\nDEMO LOGIN DETAILS');
    console.log('------------------------------');

    console.log(
      `Owner: ${PEOPLE.owner.email} / ${PEOPLE.owner.phone}`
    );

    console.log(
      `Manager: ${PEOPLE.manager.email} / ${PEOPLE.manager.phone}`
    );

    console.log(
      `Cashier: ${PEOPLE.cashier.email} / ${PEOPLE.cashier.phone}`
    );

    console.log('Cashier PIN: 2468');
    console.log('Cashier employee code: CSH01');

    console.log(
      '\nPassword: the value of DEMO_PASSWORD'
    );

    console.log('\nNo real M-Pesa payments were initiated.');

  } finally {
    if (connected) {
      await mongoose.disconnect();
      console.log('\nMongoDB connection closed.');
    }
  }
}

main().catch((error) => {
  console.error('\nSTAGING DEMO SEED FAILED:', error);
  process.exitCode = 1;
});
