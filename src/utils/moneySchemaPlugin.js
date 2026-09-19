const { fromCents } = require('./money');

/**
 * moneyFields(schema, ['costPrice', 'sellingPrice', ...])
 *
 * Apply to any schema that has cents-integer monetary fields. Output
 * (toJSON/toObject, i.e. anything sent through res.json) will show those
 * fields as decimal KES automatically. The raw integer-cents value is what
 * actually gets saved to MongoDB and is what services should read/write.
 *
 * This also recurses one level into arrays of subdocuments if a
 * `subpaths` map is given, e.g. { items: ['unitPrice', 'total'] } for
 * Sale.items.
 */
function moneyFields(schema, fields = [], subpaths = {}) {
  const transform = (doc, ret) => {
    fields.forEach((f) => {
      if (ret[f] !== undefined && ret[f] !== null) ret[f] = fromCents(ret[f]);
    });
    Object.entries(subpaths).forEach(([arrayField, subFields]) => {
      if (Array.isArray(ret[arrayField])) {
        ret[arrayField] = ret[arrayField].map((item) => {
          const copy = { ...item };
          subFields.forEach((f) => {
            if (copy[f] !== undefined && copy[f] !== null) copy[f] = fromCents(copy[f]);
          });
          return copy;
        });
      }
    });
    return ret;
  };

  schema.set('toJSON', { transform, virtuals: true });
  schema.set('toObject', { transform, virtuals: true });
}

module.exports = moneyFields;
