const { fromCents } = require('./money');
/**
 * Like moneyFields but understands nested paths and arrays at any depth:
 *   moneyPaths(schema, ['total', 'lines.total', 'items.modifiers.priceDelta'])
 * Stored values stay integer cents; JSON output is decimal KES. NEVER call toObject()/toJSON() inside service logic.
 */
function convertPath(node, segments) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach((n) => convertPath(n, segments)); return; }
  if (typeof node !== 'object') return;
  const [head, ...rest] = segments;
  if (rest.length === 0) { if (typeof node[head] === 'number') node[head] = fromCents(node[head]); return; }
  convertPath(node[head], rest);
}
function moneyPaths(schema, paths = []) {
  const split = paths.map((p) => p.split('.'));
  const transform = (doc, ret) => { split.forEach((segs) => convertPath(ret, segs)); return ret; };
  schema.set('toJSON', { transform, virtuals: true });
  schema.set('toObject', { transform, virtuals: true });
}
module.exports = moneyPaths;
module.exports.convertPath = convertPath;
