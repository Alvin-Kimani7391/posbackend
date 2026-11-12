#!/usr/bin/env node
// Usage:
//   node envcheck.js production blue.env green.env [worker.env] [--legacy /var/www/sixstar-pos/.env]
//   node envcheck.js staging   staging.env  <every production env file...>
// Parses REAL values (no string-grep). Prints variable NAMES only - never a secret value. Read-only.
const fs = require('fs');

function load(f) {
  const o = {};
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!m) return;
    let v = m[2].trim();
    if (/^['"]/.test(v)) { const q = v[0]; const e = v.indexOf(q, 1); v = e > 0 ? v.slice(1, e) : v.slice(1); }
    else v = v.replace(/\s+#.*$/, '');
    o[m[1]] = v;
  });
  return o;
}
function dbOf(uri) { // mongodb:// | mongodb+srv:// | multi-host | creds | options
  const m = String(uri || '').match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/i);
  if (!m) return null;
  return { hosts: m[1].toLowerCase().split(',').map((h) => h.replace(/:27017$/, '').replace(/^127\.0\.0\.1$/, 'localhost')).sort().join(','), name: decodeURIComponent(m[2] || '') || 'test' };
}
const key = (e) => { const d = dbOf(e.MONGODB_URI); return d ? `${d.hosts}/${d.name}` : null; };
const SECRETISH = /(KEY|SECRET|PASS|PASSWORD|TOKEN|PWD)/i;
const PER_SLOT = new Set(['PORT', 'APP_SLOT', 'RUN_JOBS', 'RELEASE_ID', 'GIT_SHA', 'WORKER_READY_FILE', 'DOTENV_CONFIG_PATH']);
const CRITICAL = new Set(['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET']);

const argv = process.argv.slice(2);
const mode = argv.shift();
let legacyFile = null; const files = [];
while (argv.length) { const a = argv.shift(); if (a === '--legacy') legacyFile = argv.shift(); else files.push(a); }

const bad = [], warn = [], envs = {};
const read = (f) => { try { return load(f); } catch { bad.push(`cannot read ${f}`); return null; } };
files.forEach((f) => { const e = read(f); if (e) envs[f] = e; });
const need = ['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
Object.entries(envs).forEach(([f, e]) => {
  need.forEach((k) => { if (!e[k]) bad.push(`${f}: missing ${k}`); });
  if (e.MONGODB_URI && !dbOf(e.MONGODB_URI)) bad.push(`${f}: MONGODB_URI is not a valid mongodb URI`);
});

if (mode === 'production') {
  const names = Object.keys(envs); const base = envs[names[0]] || {};
  const ks = [...new Set(Object.values(envs).map(key))]; if (ks.length > 1) bad.push('production env files point at DIFFERENT databases');
  names.forEach((f) => {
    const e = envs[f];
    if (e.NODE_ENV && e.NODE_ENV !== 'production') bad.push(`${f}: NODE_ENV must be production`);
    if ((e.MPESA_ENVIRONMENT || 'production') === 'sandbox') bad.push(`${f}: MPESA_ENVIRONMENT is sandbox in production`);
    if (/blue|green/.test(f) && String(e.RUN_JOBS || '').toLowerCase() === 'true') bad.push(`${f}: RUN_JOBS=true (API slots must not run jobs; the worker does)`);
  });
  // blue/green/worker must be identical except per-slot settings (otherwise sessions/payments differ after a switch)
  names.slice(1).forEach((f) => {
    const e = envs[f], diff = new Set();
    const isWorkerFile = /worker\.env$/i.test(f);
    new Set([...Object.keys(base), ...Object.keys(e)]).forEach((k) => {
      if (PER_SLOT.has(k) || (isWorkerFile && k === 'INFRA_OPERATORS')) return;
      if (base[k] !== e[k]) diff.add(k);
    });
    if (diff.size) bad.push(`${names[0]} and ${f} differ in: ${[...diff].sort().join(', ')}`);
  });
  if (legacyFile) { // compare with the live legacy .env (read-only): same DB + same secrets, so the cutover keeps sessions & payments working
    const leg = read(legacyFile);
    if (leg) {
      const cmp = envs[names[0]] || {}, miss = [], diffc = [], diffo = [];
      Object.keys(leg).forEach((k) => {
        if (PER_SLOT.has(k)) return;
        if (!(k in cmp)) miss.push(k);
        else if (cmp[k] !== leg[k]) (CRITICAL.has(k) || SECRETISH.test(k) ? diffc : diffo).push(k);
      });
      if (miss.length) bad.push(`blue.env is missing variables the live .env has: ${miss.sort().join(', ')}`);
      if (diffc.length) bad.push(`blue.env differs from the live .env in SECRET/critical variables: ${diffc.sort().join(', ')}`);
      if (diffo.length) warn.push(`blue.env differs from the live .env in: ${diffo.sort().join(', ')} (check this is intended)`);
    }
  }
} else if (mode === 'staging') {
  const sf = files[0], prodFiles = files.slice(1), s = envs[sf] || {};
  const prod = prodFiles.map((f) => [f, envs[f]]).filter(([, e]) => e);
  if (!prod.length) bad.push('no production env file supplied to compare against');
  if (s.NODE_ENV !== 'staging') bad.push('staging.env: NODE_ENV must be staging');
  if ((s.MPESA_ENVIRONMENT || '') !== 'sandbox') bad.push('staging.env: MPESA_ENVIRONMENT must be sandbox');
  if ((s.ETIMS_ENVIRONMENT || '') !== 'sandbox') bad.push('staging.env: ETIMS_ENVIRONMENT must be sandbox');
  if (String(s.RUN_JOBS || '').toLowerCase() === 'true') bad.push('staging.env: RUN_JOBS must not be true');
  const sd = dbOf(s.MONGODB_URI);
  prod.forEach(([pf, p]) => {
    const pd = dbOf(p.MONGODB_URI);
    if (sd && pd && sd.name === pd.name) bad.push(`staging database NAME "${sd.name}" equals the one in ${pf}`);
    if (sd && pd && key(s) === key(p)) bad.push(`staging and ${pf} resolve to the SAME database`);
    const shared = Object.keys(s).filter((k) => SECRETISH.test(k) && s[k] && p[k] === s[k]);   // ANY secret-looking variable reused from production
    if (shared.length) bad.push(`staging reuses production secrets (same value as ${pf}): ${shared.sort().join(', ')}`);
  });
  if (sd && !/staging|test|dev/i.test(sd.name)) bad.push(`staging database name "${sd.name}" should contain "staging"`);
} else bad.push('mode must be "production" or "staging"');

warn.forEach((w) => console.warn('WARNING: ' + w));
if (bad.length) { console.error('ENV CHECK FAILED:\n - ' + bad.join('\n - ')); process.exit(1); }
console.log(`ENV CHECK OK (${mode})`);