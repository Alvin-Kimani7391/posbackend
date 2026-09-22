const { fromCents } = require('../../utils/money');

/**
 * Maps our internal Sale (+snapshotted items) into a DigiTax invoice payload.
 * *** Field names here are the part to double-check against your DigiTax
 * onboarding pack/Postman collection - this follows the standard KRA
 * OSCU invoice shape (invcNo, trdInvcNo, itemList[] with itemSeq/hsCode/
 * qty/prc/splyAmt/taxTyCd/taxAmt/totAmt) which is what most eTIMS
 * aggregators, DigiTax included, wrap. Keep the mapping isolated here so a
 * contract mismatch is a one-file fix. ***
 */
function saleToDigiTaxInvoice({ sale, business, branch }) {
  const items = sale.items.map((item, idx) => ({
    itemSeq: idx + 1,
    itemCd: item.skuSnapshot,
    itemNm: item.nameSnapshot,
    barcode: item.barcodeSnapshot || undefined,
    qty: item.quantity,
    prc: fromCents(item.unitPrice),
    splyAmt: fromCents(item.unitPrice * item.quantity - item.discount),
    dcRt: item.quantity ? (item.discount / (item.unitPrice * item.quantity)) * 100 : 0,
    dcAmt: fromCents(item.discount),
    taxTyCd: taxTypeCode(item.taxRate),
    taxAmt: fromCents(item.taxAmount),
    totAmt: fromCents(item.total),
  }));

  return {
    tin: business.kraPin,
    bhfId: branch?.code || '00',
    trdInvcNo: sale.invoiceNumber || sale.receiptNumber,
    invcNo: sale.receiptNumber,
    salesDt: sale.createdAt,
    salesTyCd: 'N', // Normal sale - adjust for credit note / training mode per DigiTax's enum
    rcptTyCd: 'S',
    pmtTyCd: derivePaymentTypeCode(sale),
    totItemCnt: items.length,
    taxblAmtA: fromCents(sale.subtotal - sale.itemDiscount - sale.cartDiscount),
    taxAmtA: fromCents(sale.tax),
    totTaxblAmt: fromCents(sale.subtotal - sale.itemDiscount - sale.cartDiscount),
    totTaxAmt: fromCents(sale.tax),
    totAmt: fromCents(sale.total),
    itemList: items,
  };
}

function taxTypeCode(ratePercent) {
  // KRA's standard codes: A=exempt, B=standard 16%, C=zero-rated, D=non-VAT.
  // Confirm this mapping matches your product.taxCategory conventions.
  if (!ratePercent) return 'A';
  if (ratePercent >= 15) return 'B';
  return 'C';
}

function derivePaymentTypeCode(sale) {
  if (sale.paymentStatus === 'CREDIT') return '05';
  return '01'; // cash/mixed - refine per-payment-method if DigiTax wants granularity
}

module.exports = { saleToDigiTaxInvoice };