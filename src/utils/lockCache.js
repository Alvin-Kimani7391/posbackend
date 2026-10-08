// Tiny in-process cache so the lock check doesn't hit Mongo on every API call.
const cache = new Map();
const TTL = 20 * 1000;

exports.get = (id) => { const e = cache.get(String(id)); return e && e.exp > Date.now() ? e.v : undefined; };
exports.set = (id, v) => { if (cache.size > 5000) cache.clear(); cache.set(String(id), { v, exp: Date.now() + TTL }); };
exports.invalidate = (id) => cache.delete(String(id));