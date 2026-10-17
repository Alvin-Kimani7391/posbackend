/**
 * Builds the Sale + Receipt (+ audit + eTIMS enqueue) for work that was paid for over time and is invoiced when it is
 * finished: layaway collection, a layaway cancellation fee. Same numbering, same receipt snapshot and same eTIMS path as a
 * till sale, so the money shows up in the sales / profit / cashier reports and in KRA like any other sale.
 * NO stock moves here: the caller has already dealt with stock.
 * Runs inside the caller's transaction.
 */
const Sale = require('../models/Sale');
const Receipt = require('../models/Receipt');
const Branch = require('../models/Branch');
const AuditLog = require('../models/AuditLog');
const etimsService = require('./etims.service');
const { nextSequence, pad } = require('../models/Counter');
const { buildContext } = require('../utils/businessContext');

async function createInvoiceSale({ business, branchId, user, session, customer, items, totals, payments, source, links = {}, notes, extraReceiptLines = [], paid, balance = 0 }) {
  const businessId = business._id;
  const branch = await Branch.findById(branchId).session(session);
  const rSeq = await nextSequence(businessId, `receipt:branch:${branchId}`, session);
  const receiptNumber = `${business.receiptSettings?.receiptPrefix || 'RCT'}-${branch?.code || 'MAIN'}-${pad(rSeq)}`;
  const iSeq = await nextSequence(businessId, `invoice:branch:${branchId}`, session);
  const invoiceNumber = `${business.receiptSettings?.invoicePrefix || 'INV'}-${branch?.code || 'MAIN'}-${pad(iSeq)}`;
  const now = new Date();

  const [sale] = await Sale.create([{
    businessId, branchId, receiptNumber, invoiceNumber, customerId: customer?._id || customer?.id, cashierId: user._id,
    items, subtotal: totals.subtotal, itemDiscount: totals.itemDiscount || 0, cartDiscount: 0, tax: totals.tax, total: totals.total,
    amountPaid: paid, balance, paymentStatus: balance > 0 ? (paid > 0 ? 'PARTIAL' : 'CREDIT') : 'PAID', saleStatus: 'COMPLETED', source, ...links, notes, soldAt: now,
  }], { session });

  const rs = business.receiptSettings || {};
  await Receipt.create([{
    businessId, branchId, saleId: sale._id, receiptNumber, invoiceNumber, soldAt: now,
    receiptData: {
      // Currency / country / language frozen at sale time (KRA PIN in Kenya, TIN / VRN in Tanzania).
      locale: (() => { const c = buildContext(business); return { currency: c.currency, countryCode: c.countryCode, language: c.language, taxIdLabel: c.country.taxIdLabel[c.language] }; })(),
      business: {
        name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin || business.taxPin, vrn: business.vrn,
        footerMessage: rs.footerMessage, headerMessage: rs.headerMessage, logo: rs.showLogo ? business.logo : undefined,
        showKraPin: rs.showKraPin ?? true, showCashierName: rs.showCashierName ?? true, showMpesaReceiptCode: rs.showMpesaReceiptCode ?? true,
        customLines: [...(rs.customLines || []), ...extraReceiptLines], paperWidth: rs.paperWidth || '80mm',
      },
      branch: { name: branch?.name, phone: branch?.phone },
      cashier: { name: user.name },
      customer: customer ? { name: customer.name, phone: customer.phone } : null,
      items: items.map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount || 0, taxRate: i.taxRate, taxAmount: i.taxAmount, total: i.total })),
      subtotal: totals.subtotal, itemDiscount: totals.itemDiscount || 0, cartDiscount: 0, tax: totals.tax, total: totals.total,
      payments, amountTendered: 0, changeGiven: 0, balance, paymentStatus: balance > 0 ? (paid > 0 ? 'PARTIAL' : 'CREDIT') : 'PAID',
    },
  }], { session });

  await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'sale.create', entityType: 'Sale', entityId: sale._id, newValue: { receiptNumber, total: totals.total, source } }], { session });
  await etimsService.enqueueForSale(businessId, branchId, sale._id, { session });
  return sale;
}

module.exports = { createInvoiceSale };