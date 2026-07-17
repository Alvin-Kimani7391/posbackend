const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Medication = require('../models/Medication');

function generateInvoiceNumber() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.floor(100 + Math.random() * 900);
  return `INV-${stamp}-${rand}`;
}

function startDateFor(range) {
  const start = new Date();
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else if (range === 'week') start.setDate(start.getDate() - 7);
  else if (range === 'month') start.setMonth(start.getMonth() - 1);
  else return null;
  return start;
}

// GET /api/sales?range=today|week|month|all
router.get('/', async (req, res) => {
  try {
    const { range = 'today' } = req.query;
    const filter = {};
    const start = startDateFor(range);
    if (start) filter.created_at = { $gte: start };
    const sales = await Sale.find(filter)
      .sort({ created_at: -1 })
      .limit(200)
      .populate('patient_id', 'name medical_record_number')
      .populate('worker_id', 'name role');
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sales/reports/summary?range=today|week|month|all
router.get('/reports/summary', async (req, res) => {
  try {
    const { range = 'today' } = req.query;
    const filter = {};
    const start = startDateFor(range);
    if (start) filter.created_at = { $gte: start };
    const sales = await Sale.find(filter);
    const totalRevenue = sales.reduce((s, x) => s + x.total, 0);
    const totalTransactions = sales.length;
    const totalItems = sales.reduce((s, x) => s + x.sale_items.reduce((q, i) => q + i.quantity, 0), 0);
    const avgTransaction = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;
    res.json({ totalRevenue, totalTransactions, totalItems, avgTransaction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sales  -> checkout: creates sale, decrements medication stock
router.post('/', async (req, res) => {
  const { patient_id, worker_id, items, tax_rate = 0, discount = 0, payment_method = 'cash' } = req.body;

  if (!worker_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'worker_id and at least one item are required' });
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // Validate stock and build sale items inside the transaction
    const saleItems = [];
    for (const item of items) {
      const med = await Medication.findById(item.medication_id).session(session);
      if (!med) throw new Error(`Medication not found: ${item.name || item.medication_id}`);
      if (med.stock_quantity < item.quantity) {
        throw new Error(`Not enough stock for ${med.name}. Available: ${med.stock_quantity}`);
      }
      med.stock_quantity -= item.quantity;
      await med.save({ session });
      saleItems.push({
        medication_id: med._id,
        name: med.name,
        barcode: med.barcode,
        quantity: item.quantity,
        unit_price: med.price,
        total: med.price * item.quantity,
      });
    }

    const subtotal = saleItems.reduce((s, i) => s + i.total, 0);
    const tax_amount = (subtotal * tax_rate) / 100;
    const total = subtotal + tax_amount - discount;

    const [sale] = await Sale.create(
      [
        {
          invoice_number: generateInvoiceNumber(),
          patient_id: patient_id || null,
          worker_id,
          subtotal,
          tax_rate,
          tax_amount,
          discount,
          total,
          payment_method,
          payment_status: 'paid',
          sale_items: saleItems,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const populated = await Sale.findById(sale._id).populate('patient_id', 'name medical_record_number').populate('worker_id', 'name role');
    res.status(201).json(populated);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
