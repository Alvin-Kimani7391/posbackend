/** Hidden service products that let non-menu lines (service charge, delivery fee) travel on a normal Sale and eTIMS invoice. */
const Product = require('../../models/Product');
async function ensureSystemProduct(businessId, sku, name, taxRate, session) {
  let p = await Product.findOne({ businessId, sku }).session(session || null);
  if (!p) {
    try { [p] = await Product.create([{ businessId, name, sku, productType: 'service', unit: 'service', trackInventory: false, costPrice: 0, sellingPrice: 0, taxRate, status: 'active' }], session ? { session } : {}); }
    catch (e) { if (e.code === 11000) p = await Product.findOne({ businessId, sku }).session(session || null); else throw e; }
  }
  return p;
}
module.exports = { ensureSystemProduct, DELIVERY_FEE_SKU: 'RESTAURANT-DELIVERY-FEE' };
