const { Schema, model } = require('mongoose');

/**
 * A saved, rule-based audience ("Nairobi lunch crowd", "Spent > 10k, quiet 30+ days").
 * Segments store RULES, not member ids - membership is evaluated live, so it is always current.
 * Phase 2 (SMS) targets a segment by id and asks crm.service.getSegmentAudience() for members.
 */
const ruleSchema = new Schema(
  {
    field: { type: String, required: true },
    op: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
    value2: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const customerSegmentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    color: { type: String, default: '#0f766e' },
    match: { type: String, enum: ['all', 'any'], default: 'all' },
    rules: { type: [ruleSchema], default: [] },
    memberCount: { type: Number, default: 0 }, // cached at save time; list endpoint recomputes live
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

customerSegmentSchema.index({ businessId: 1, name: 1 }, { unique: true });

module.exports = model('CustomerSegment', customerSegmentSchema);