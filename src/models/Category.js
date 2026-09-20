const { Schema, model } = require('mongoose');

const categorySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    parentCategoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    image: { type: String },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

categorySchema.index({ businessId: 1, parentCategoryId: 1 });
categorySchema.index({ businessId: 1, name: 1 });

module.exports = model('Category', categorySchema);
