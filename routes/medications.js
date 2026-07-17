const express = require('express');
const router = express.Router();
const Medication = require('../models/Medication');

// GET /api/medications?search=...
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let filter = {};
    if (search) {
      const re = new RegExp(search, 'i');
      filter = { $or: [{ name: re }, { generic_name: re }, { barcode: re }, { category: re }] };
    }
    const meds = await Medication.find(filter).sort({ name: 1 });
    res.json(meds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/medications/barcode/:code  -> used by the barcode scanner
router.get('/barcode/:code', async (req, res) => {
  try {
    const med = await Medication.findOne({ barcode: req.params.code });
    if (!med) return res.status(404).json({ error: 'No medication found for this barcode' });
    res.json(med);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const med = await Medication.findById(req.params.id);
    if (!med) return res.status(404).json({ error: 'Medication not found' });
    res.json(med);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const med = await Medication.create(req.body);
    res.status(201).json(med);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const med = await Medication.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!med) return res.status(404).json({ error: 'Medication not found' });
    res.json(med);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/medications/:id/stock  { delta: number }  -> restock or adjust via barcode scan
router.patch('/:id/stock', async (req, res) => {
  try {
    const { delta } = req.body;
    if (typeof delta !== 'number') return res.status(400).json({ error: 'delta must be a number' });
    const med = await Medication.findById(req.params.id);
    if (!med) return res.status(404).json({ error: 'Medication not found' });
    med.stock_quantity = Math.max(0, med.stock_quantity + delta);
    await med.save();
    res.json(med);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const med = await Medication.findByIdAndDelete(req.params.id);
    if (!med) return res.status(404).json({ error: 'Medication not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
