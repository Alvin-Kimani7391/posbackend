/** General-shop module constants (held sales, promotions, price tools, product import, onboarding). */
const HELD_TTL_HOURS = 24;
const HELD_MAX_PER_CASHIER = 20;
const IMPORT_MAX_ROWS = 2000;

// Columns accepted by the product import. Aliases are matched case-insensitively with spaces/underscores ignored.
const IMPORT_COLUMNS = [
  { key: 'name', label: 'Name', required: true, aliases: ['product', 'productname', 'item', 'itemname', 'description1'] },
  { key: 'sku', label: 'SKU', aliases: ['code', 'itemcode', 'productcode'] },
  { key: 'barcode', label: 'Barcode', aliases: ['ean', 'upc', 'barcodenumber'] },
  { key: 'category', label: 'Category', aliases: ['group', 'department'] },
  { key: 'brand', label: 'Brand', aliases: ['make', 'manufacturer'] },
  { key: 'unit', label: 'Unit', aliases: ['uom', 'unitofmeasure'] },
  { key: 'costPrice', label: 'Cost price', aliases: ['cost', 'buyingprice', 'purchaseprice', 'bp'] },
  { key: 'sellingPrice', label: 'Selling price', required: true, aliases: ['price', 'retailprice', 'sp', 'sellprice'] },
  { key: 'taxRate', label: 'Tax rate %', aliases: ['tax', 'vat', 'vatrate'] },
  { key: 'lowStockThreshold', label: 'Reorder level', aliases: ['minstock', 'minimumstock', 'reorderlevel', 'lowstock'] },
  { key: 'openingStock', label: 'Opening stock', aliases: ['stock', 'quantity', 'qty', 'onhand', 'openingquantity'] },
  { key: 'description', label: 'Description', aliases: ['details', 'notes'] },
  { key: 'image', label: 'Image URL', aliases: ['imageurl', 'photo', 'picture'] },
];

// Starter categories offered during onboarding (the owner picks which to create).
const STARTER_CATEGORIES = {
  general_shop: ['Groceries', 'Beverages', 'Snacks & Sweets', 'Household & Cleaning', 'Personal Care', 'Stationery', 'Airtime & Services', 'Baby Items', 'Hardware & Tools', 'Other'],
  supermarket: ['Fresh Produce', 'Bakery', 'Dairy', 'Meat & Fish', 'Groceries', 'Beverages', 'Frozen', 'Household', 'Personal Care', 'Baby'],
  other: ['General', 'Services'],
};

const ROUNDING = { NONE: 0, NEAREST_1: 100, NEAREST_5: 500, NEAREST_10: 1000, NEAREST_50: 5000 }; // value in cents

module.exports = { HELD_TTL_HOURS, HELD_MAX_PER_CASHIER, IMPORT_MAX_ROWS, IMPORT_COLUMNS, STARTER_CATEGORIES, ROUNDING };
