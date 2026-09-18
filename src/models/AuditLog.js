const { Schema, model } = require('mongoose');

const auditLogSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true }, // e.g. 'login', 'product.create', 'sale.cancel'
    entityType: { type: String },
    entityId: { type: Schema.Types.ObjectId },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
    userAgent: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false, capped: false }
);

auditLogSchema.index({ businessId: 1, timestamp: -1 });

// Audit logs are append-only: block updates and deletes at the model layer.
auditLogSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function blockUpdate(next) {
  next(new Error('AuditLog records are immutable and cannot be updated'));
});
auditLogSchema.pre(['deleteOne', 'findOneAndDelete', 'deleteMany'], function blockDelete(next) {
  next(new Error('AuditLog records are immutable and cannot be deleted'));
});

module.exports = model('AuditLog', auditLogSchema);
