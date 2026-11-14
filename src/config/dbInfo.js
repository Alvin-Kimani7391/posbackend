/** Describes a MongoDB connection string WITHOUT ever exposing credentials or host names (safe for health endpoints and the admin dashboard). */
function describeUri(uri) {
  const m = String(uri || '').match(/^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i);
  if (!m) return { kind: 'unknown', local: false, replicaSet: false };
  const hosts = m[2].toLowerCase().split(',').map((h) => h.replace(/:\d+$/, ''));
  const local = !m[1] && hosts.every((h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h));
  const kind = local ? 'local' : /mongodb\.net$/.test(hosts[0]) ? 'atlas' : 'remote';
  const q = new URLSearchParams(m[4] || '');
  return { kind, local, replicaSet: !!q.get('replicaSet') || !!m[1] || hosts.length > 1 };
}
module.exports = { describeUri };
