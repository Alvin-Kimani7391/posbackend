/**
 * What a till needs to run wines & spirits sales, readable by anyone who can sell (sales.create).
 * Cashiers do not hold liquor.empties / liquor.products by default, so the till must not depend on those routes.
 * The same payload is cached on the device so the age check and the empties prompt keep working with no internet.
 */
const LiquorDetails = require('../../models/LiquorDetails');
const ContainerType = require('../../models/ContainerType');
const settingsSvc = require('./settings.service');
const { fromCents } = require('../../utils/money');

async function context(businessId) {
  const [st, details, containers] = await Promise.all([
    settingsSvc.status(businessId),
    LiquorDetails.find({ businessId, isAlcohol: true }).select('productId category abv volumeMl').lean(),
    ContainerType.find({ businessId, active: { $ne: false } }).select('name kind deposit depositProductId').lean(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    minAge: st.minAge, ageMode: st.ageMode, emptiesMode: st.emptiesMode, trading: st.trading,
    alcoholProducts: details.map((d) => ({ productId: String(d.productId), category: d.category, abv: d.abv, volumeMl: d.volumeMl })),
    containers: containers.map((c) => ({ _id: String(c._id), name: c.name, kind: c.kind, deposit: fromCents(c.deposit || 0), depositProductId: c.depositProductId ? String(c.depositProductId) : null })),
  };
}

module.exports = { context };
