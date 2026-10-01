const { Schema, model } = require('mongoose');
const { TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES } = require('../constants/ticket');

const attachmentSchema = new Schema(
  {
    url: { type: String, required: true },     // Cloudinary secure URL
    publicId: { type: String },                // Cloudinary public_id (for deletion later)
    originalName: { type: String },
    size: { type: Number },
    format: { type: String },
  },
  { _id: false }
);

const replySchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String },
    authorRole: { type: String },
    isStaff: { type: Boolean, default: false }, // true = platform support (super admin)
    message: { type: String, required: true, maxlength: 3000 },
    attachments: [attachmentSchema],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const ticketSchema = new Schema(
  {
    ticketNumber: { type: String, required: true, unique: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },

    raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    raisedByName: { type: String },
    raisedByRole: { type: String },

    subject: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, required: true, maxlength: 3000 },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'OTHER' },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'MEDIUM' },

    errorMessage: { type: String, maxlength: 5000 }, // pasted error text
    pageUrl: { type: String, maxlength: 500 },       // screen where it happened
    userAgent: { type: String, maxlength: 500 },
    attachments: [attachmentSchema],                 // screenshots

    status: { type: String, enum: TICKET_STATUSES, default: 'OPEN', index: true },
    awaitingAdmin: { type: Boolean, default: true, index: true }, // true = ball is in support's court
    replies: [replySchema],

    resolution: { type: String, maxlength: 3000 },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    firstResponseAt: { type: Date },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ticketSchema.index({ businessId: 1, lastActivityAt: -1 });
ticketSchema.index({ status: 1, lastActivityAt: -1 });

module.exports = model('Ticket', ticketSchema);
