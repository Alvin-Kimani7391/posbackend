const Receipt = require('../models/Receipt');
const ApiError = require('../utils/ApiError');

async function getReceiptBySale(businessId, saleId) {
  const receipt = await Receipt.findOne({ businessId, saleId });
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return receipt;
}

/** Called when the POS actually sends the receipt to a printer - increments the historical print count. */
async function recordPrint(businessId, saleId) {
  const receipt = await Receipt.findOneAndUpdate(
    { businessId, saleId },
    { $inc: { printCount: 1 }, $set: { printedAt: new Date() } },
    { new: true }
  );
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return receipt;
}

module.exports = { getReceiptBySale, recordPrint };
