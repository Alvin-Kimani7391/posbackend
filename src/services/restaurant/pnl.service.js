/**
 * Restaurant profit & loss: what the owner actually keeps.
 *
 *   Net sales      = paid bills - tax - refunds
 *   Cost of sales  = food cost (see basis) [+ wastage, staff meals, comps, stock-count losses on the RECIPE basis]
 *   Gross profit   = net sales - cost of sales
 *   Salaries       = approved expenses in category Salary / Wages
 *   Other expenses = every other approved expense (rent, power, transport ...)
 *   Net profit     = gross profit - salaries - other expenses
 *
 * Food cost basis (settings.tracking.costBasis):
 *   RECIPE     real ingredient usage from the stock ledger (what the kitchen actually took out for sold dishes) - needs tracking ON.
 *              Dishes without a recipe (e.g. bottled drinks) count at the cost entered on the menu.
 *   PURCHASES  what was bought in the period: ingredient deliveries + expenses recorded as "Food Purchases" (cash view; no recipes needed).
 *   AUTO       RECIPE when tracking is on, otherwise PURCHASES.
 * Only APPROVED expenses count; pending ones are reported separately so nothing is silently missing.
 */
const RestaurantBill = require('../../models/RestaurantBill');
const Payment = require('../../models/Payment');
const IngredientMovement = require('../../models/IngredientMovement');
const IngredientPurchase = require('../../models/IngredientPurchase');
const IngredientStock = require('../../models/IngredientStock');
const Ingredient = require('../../models/Ingredient');
const MenuItem = require('../../models/MenuItem');
const Expense = require('../../models/Expense');
const { fromCents: k } = require('../../utils/money');
const C = require('./common');

const SALARY = ['Salary', 'Wages'];
const FOOD = ['Food Purchases'];
const COST_TYPES = ['CONSUMPTION', 'CONSUMPTION_REVERSAL', 'WASTE', 'SPOILAGE', 'EXPIRED', 'STAFF_MEAL', 'COMPLIMENTARY'];
const signed = { $multiply: [{ $cond: [{ $lt: ['$quantity', 0] }, 1, -1] }, '$value'] };   // + = stock (and its cost) left the shelf
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

function offsetMs(tz, d) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
  } catch (e) { return 3 * 3600000; }
}
const midnightUTC = (d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
/** Plain dates (2026-10-01 .. 2026-10-31) mean whole days in the business's own time zone. Default: last 30 days. */
function windowOf(from, to, tz) {
  let end = to ? new Date(to) : new Date(); let start = from ? new Date(from) : null;
  if (to && midnightUTC(end)) end = new Date(end.getTime() - offsetMs(tz, end) + 86400000 - 1);
  if (!start) start = new Date(end.getTime() - 30 * 86400000); else if (midnightUTC(start)) start = new Date(start.getTime() - offsetMs(tz, start));
  return { start, end };
}

async function profitAndLoss(businessId, user, { branchId, from, to }) {
  if (!C.can(user, 'reports.profit')) return { restricted: true };
  const ctx = await C.getContext(businessId);
  const tz = ctx.timeZone; const { start, end } = windowOf(from, to, tz);
  const trackingOn = ctx.features.recipes; const cfg = ctx.settings.tracking || {};
  const wanted = cfg.costBasis || 'AUTO';
  const basis = wanted === 'PURCHASES' || !trackingOn ? 'PURCHASES' : 'RECIPE';
  const bf = { businessId: C.oid(businessId), ...C.branchFilter(C.branchScope(user, branchId)) };
  const day = (f) => ({ $dateToString: { format: '%Y-%m-%d', date: f, timezone: tz } });
  const billM = { ...bf, status: 'PAID', settledAt: { $gte: start, $lte: end } };
  const expM = { ...bf, expenseDate: { $gte: start, $lte: end } };
  const movM = { ...bf, createdAt: { $gte: start, $lte: end } };
  const [bills, dishes, billDays, refunds, mov, movDays, purch, purchDays, exp, expPending, expDays, stocks] = await Promise.all([
    RestaurantBill.aggregate([{ $match: billM }, { $group: { _id: null, bills: { $sum: 1 }, revenue: { $sum: { $subtract: ['$total', '$waived'] } }, tax: { $sum: '$tax' }, serviceCharge: { $sum: '$serviceCharge' }, discount: { $sum: '$discount' }, comps: { $sum: '$compValue' }, cost: { $sum: '$cost' } } }]),
    RestaurantBill.aggregate([{ $match: billM }, { $unwind: '$lines' }, { $match: { 'lines.isComp': { $ne: true } } }, { $group: { _id: '$lines.menuItemId', name: { $first: '$lines.name' }, sold: { $sum: '$lines.quantity' }, revenue: { $sum: { $subtract: ['$lines.total', '$lines.taxAmount'] } }, cost: { $sum: '$lines.cost' } } }, { $sort: { revenue: -1 } }, { $limit: 200 }]),
    RestaurantBill.aggregate([{ $match: billM }, { $group: { _id: day('$settledAt'), bills: { $sum: 1 }, revenue: { $sum: { $subtract: [{ $subtract: ['$total', '$waived'] }, '$tax'] } } } }]),
    Payment.aggregate([{ $match: { ...bf, restaurantBillId: { $ne: null }, status: 'REFUNDED', createdAt: { $gte: start, $lte: end } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    trackingOn ? IngredientMovement.aggregate([{ $match: { ...movM, type: { $in: [...COST_TYPES, 'COUNT_ADJUSTMENT', 'ADJUSTMENT'] } } }, { $group: { _id: '$type', cost: { $sum: signed } } }]) : [],
    trackingOn ? IngredientMovement.aggregate([{ $match: { ...movM, type: { $in: COST_TYPES } } }, { $group: { _id: day('$createdAt'), cost: { $sum: signed } } }]) : [],
    IngredientPurchase.aggregate([{ $match: { ...bf, receivedAt: { $gte: start, $lte: end } } }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]),
    IngredientPurchase.aggregate([{ $match: { ...bf, receivedAt: { $gte: start, $lte: end } } }, { $group: { _id: day('$receivedAt'), total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $match: { ...expM, status: 'APPROVED' } }, { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { total: -1 } }]),
    Expense.aggregate([{ $match: { ...expM, status: 'PENDING' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Expense.aggregate([{ $match: { ...expM, status: 'APPROVED' } }, { $group: { _id: { d: day('$expenseDate'), c: '$category' }, total: { $sum: '$amount' } } }]),
    trackingOn ? IngredientStock.find(bf).lean() : [],
  ]);

  const b = bills[0] || {}; const refund = refunds[0]?.total || 0;
  const netSales = (b.revenue || 0) - (b.tax || 0) - refund;
  const m = Object.fromEntries(mov.map((x) => [x._id, x.cost]));
  const catTotal = Object.fromEntries(exp.map((x) => [x._id, x.total]));
  const salaries = SALARY.reduce((t, c) => t + (catTotal[c] || 0), 0);
  const foodExpenses = FOOD.reduce((t, c) => t + (catTotal[c] || 0), 0);
  const otherExpenseRows = exp.filter((x) => !SALARY.includes(x._id) && !FOOD.includes(x._id));
  const otherExpenses = otherExpenseRows.reduce((t, x) => t + x.total, 0);

  // dishes: which ones are costed by recipe and which at a typed-in cost
  const meta = new Map((await MenuItem.find({ _id: { $in: dishes.map((d) => d._id).filter(Boolean) } }).select('stockMode').lean()).map((x) => [String(x._id), x.stockMode]));
  const otherDirect = dishes.filter((d) => meta.get(String(d._id)) !== 'RECIPE').reduce((t, d) => t + d.cost, 0);

  let foodCost; let costLines;
  if (basis === 'RECIPE') {
    const usage = (m.CONSUMPTION || 0) + (m.CONSUMPTION_REVERSAL || 0);
    const wastage = (m.WASTE || 0) + (m.SPOILAGE || 0) + (m.EXPIRED || 0);
    const staffMeals = m.STAFF_MEAL || 0; const comps = m.COMPLIMENTARY || 0;
    const variance = (m.COUNT_ADJUSTMENT || 0) + (m.ADJUSTMENT || 0);   // stock-count shortages (+) and surpluses (-)
    costLines = { ingredientsUsedInSoldDishes: usage, dishesWithoutRecipe: otherDirect, wastage, staffMeals, complimentary: comps, stockCountLosses: variance };
    foodCost = usage + otherDirect + wastage + staffMeals + comps + variance;
  } else {
    const bought = purch[0]?.total || 0;
    costLines = { ingredientPurchases: bought, foodPurchaseExpenses: foodExpenses };
    foodCost = bought + foodExpenses;
  }
  const grossProfit = netSales - foodCost;
  const netProfit = grossProfit - salaries - otherExpenses;
  const theoretical = b.cost || 0;
  const usageActual = (m.CONSUMPTION || 0) + (m.CONSUMPTION_REVERSAL || 0);

  // per day
  const days = new Map(); const dd = (d) => { if (!days.has(d)) days.set(d, { date: d, bills: 0, netSales: 0, foodCost: 0, expenses: 0 }); return days.get(d); };
  for (const x of billDays) { const r = dd(x._id); r.bills = x.bills; r.netSales = x.revenue; }
  if (basis === 'RECIPE') for (const x of movDays) dd(x._id).foodCost += x.cost;
  else { for (const x of purchDays) dd(x._id).foodCost += x.total; for (const x of expDays) if (FOOD.includes(x._id.c)) dd(x._id.d).foodCost += x.total; }
  for (const x of expDays) if (!FOOD.includes(x._id.c)) dd(x._id.d).expenses += x.total;
  const trend = [...days.values()].sort((a, c) => (a.date < c.date ? -1 : 1)).map((r) => ({ date: r.date, bills: r.bills, netSales: k(r.netSales), foodCost: k(r.foodCost), expenses: k(r.expenses), profit: k(r.netSales - r.foodCost - r.expenses) }));

  const target = cfg.targetFoodCostPercent ?? 35;
  const dishRows = dishes.map((d) => ({ menuItemId: d._id, name: d.name, sold: d.sold, revenue: k(d.revenue), cost: k(d.cost), profit: k(d.revenue - d.cost), foodCostPercent: pct(d.cost, d.revenue), overTarget: d.revenue > 0 && (d.cost / d.revenue) * 100 > target, costedBy: meta.get(String(d._id)) === 'RECIPE' ? 'RECIPE' : 'ENTERED_COST' }));
  const foodPct = pct(foodCost, netSales);
  const warnings = [];
  if (!trackingOn) warnings.push({ code: 'TRACKING_OFF', message: 'Ingredient tracking is off: food cost is what you bought (record purchases as "Food Purchases" expenses). Turn tracking on for the real cost of what was sold.' });
  if (wanted === 'RECIPE' && !trackingOn) warnings.push({ code: 'BASIS_FALLBACK', message: 'Cost basis is set to RECIPE but tracking is off, so purchases were used.' });
  if (expPending[0]?.count) warnings.push({ code: 'PENDING_EXPENSES', message: `${expPending[0].count} expense(s) worth ${k(expPending[0].total)} are waiting for approval and are NOT counted yet.` });
  if (!salaries) warnings.push({ code: 'NO_SALARIES', message: 'No approved salary or wages expense in this period, so net profit is overstated.' });
  if (basis === 'RECIPE' && dishRows.some((d) => d.costedBy !== 'RECIPE' && d.cost === 0)) warnings.push({ code: 'DISHES_WITHOUT_COST', message: 'Some dishes sold have no recipe and no cost, so their cost is zero.' });
  if (foodPct !== null && foodPct > target) warnings.push({ code: 'FOOD_COST_HIGH', message: `Food cost is ${foodPct}% of sales; your target is ${target}%.` });
  if (foodExpenses && basis === 'RECIPE') warnings.push({ code: 'FOOD_EXPENSES_IGNORED', message: `Expenses recorded as "Food Purchases" (${k(foodExpenses)}) are not counted on the recipe basis (the stock ledger is used instead).` });

  let stockValue = null;
  if (trackingOn) {
    const ings = await Ingredient.find({ businessId }).select('costPerBase').lean(); const cp = new Map(ings.map((i) => [String(i._id), i.costPerBase || 0]));
    stockValue = k(Math.round(stocks.reduce((t, s) => t + Math.max(0, s.quantity) * (cp.get(String(s.ingredientId)) || 0), 0)));
  }

  return {
    from: start, to: end, timeZone: tz, branchId: branchId || null, costBasis: basis, trackingEnabled: trackingOn,
    sales: { bills: b.bills || 0, grossSales: k(b.revenue || 0), tax: k(b.tax || 0), refunds: k(refund), netSales: k(netSales), serviceChargeIncluded: k(b.serviceCharge || 0), discountsGiven: k(b.discount || 0), complimentaryValue: k(b.comps || 0) },
    costOfSales: { total: k(foodCost), percentOfSales: foodPct, targetPercent: target, lines: Object.fromEntries(Object.entries(costLines).map(([a, v]) => [a, k(v)])) },
    grossProfit: k(grossProfit), grossMarginPercent: pct(grossProfit, netSales),
    expenses: { salaries: k(salaries), salaryPercentOfSales: pct(salaries, netSales), other: k(otherExpenses), otherByCategory: otherExpenseRows.map((x) => ({ category: x._id, amount: k(x.total), count: x.count })), pendingApproval: k(expPending[0]?.total || 0), pendingCount: expPending[0]?.count || 0 },
    netProfit: k(netProfit), netMarginPercent: pct(netProfit, netSales), primeCostPercent: pct(foodCost + salaries, netSales),
    recipeCheck: trackingOn ? { theoreticalCostOfSoldDishes: k(theoretical), actualIngredientUsage: k(usageActual), difference: k(usageActual - theoretical), note: 'Theoretical = recipe cost of dishes sold (incl. comps). A large positive difference means over-portioning, theft or unrecorded waste.' } : null,
    stock: trackingOn ? { valueOnHand: stockValue, purchasesInPeriod: k(purch[0]?.total || 0), purchaseCount: purch[0]?.count || 0 } : null,
    dishes: dishRows.slice(0, 100), trend, warnings,
  };
}

module.exports = { profitAndLoss };
