const express = require('express');
const router = express.Router();
const Prescription = require('../models/Prescription');

// GET /api/prescriptions?patient_id=...&status=...
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.patient_id) filter.patient_id = req.query.patient_id;
    if (req.query.status) filter.status = req.query.status;
    const rx = await Prescription.find(filter).sort({ created_at: -1 }).populate('patient_id', 'name medical_record_number');
    res.json(rx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const rx = await Prescription.create({ ...req.body, status: 'pending' });
    res.status(201).json(rx);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'dispensed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const rx = await Prescription.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });
    res.json(rx);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rx = await Prescription.findByIdAndDelete(req.params.id);
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
