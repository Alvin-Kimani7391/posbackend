/**
 * infra.service.js - read-only server/release/log monitoring + a tiny allowlisted action runner.
 * The POS API NEVER runs shell commands: actions go through ONE fixed helper (/usr/local/bin/sixstar-ops)
 * via execFile (no shell), with verbs and arguments validated against allowlists here AND in the helper.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const BASE = process.env.INFRA_BASE || '/var/www/sixstar-pos';
const OPS = process.env.INFRA_OPS_BIN || '/usr/local/bin/sixstar-ops';
const LOG_DIR = path.join(BASE, 'shared/logs');
const SLOT_PORT = { blue: 5100, green: 5101, legacy: 5000 };   // legacy = original process 'sixstar-pos' on :5000
const SERVICES = ['sixstar-blue', 'sixstar-green', 'sixstar-worker', 'sixstar-staging'];
const RANK = { debug: 0, info: 1, warn: 2, error: 3 };

/* ---------- tiny TTL cache so dashboard polling can never hammer the server ---------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  if (hit && hit.p) return hit.p; // de-dupe concurrent calls
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); return v; }, (e) => { cache.delete(key); throw e; });
  cache.set(key, { at: hit ? hit.at : 0, v: hit && hit.v, p });
  return p;
}

/* ---------- server metrics (Linux; all cheap file reads) ---------- */
let prevCpu = null;
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
async function cpuPct() {
  const a = prevCpu || (await (async () => { const s = cpuTimes(); await new Promise((r) => setTimeout(r, 200)); return s; })());
  const b = cpuTimes(); prevCpu = b;
  const dt = b.total - a.total;
  return dt > 0 ? Math.round((1 - (b.idle - a.idle) / dt) * 1000) / 10 : 0;
}
async function memInfo() {
  try {
    const t = await fsp.readFile('/proc/meminfo', 'utf8');
    const kb = (k) => Number((t.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
    return { total: Math.round(kb('MemTotal') / 1024), used: Math.round((kb('MemTotal') - kb('MemAvailable')) / 1024) };
  } catch { const tot = os.totalmem() / 1048576; return { total: Math.round(tot), used: Math.round(tot - os.freemem() / 1048576) }; }
}
let prevNet = null;
async function netRates() {
  try {
    const t = await fsp.readFile('/proc/net/dev', 'utf8'); let rx = 0, tx = 0;
    t.split('\n').slice(2).forEach((l) => { const [i, rest] = l.split(':'); if (!rest || i.trim() === 'lo') return; const f = rest.trim().split(/\s+/); rx += Number(f[0]); tx += Number(f[8]); });
    const now = Date.now(), out = { inKbps: 0, outKbps: 0 };
    if (prevNet) { const s = (now - prevNet.at) / 1000; if (s > 0) { out.inKbps = Math.round((rx - prevNet.rx) / 1024 / s); out.outKbps = Math.round((tx - prevNet.tx) / 1024 / s); } }
    prevNet = { at: now, rx, tx }; return out;
  } catch { return { inKbps: 0, outKbps: 0 }; }
}
async function serverStats() {
  const [cpu, mem, net, st] = await Promise.all([cpuPct(), memInfo(), netRates(), fsp.statfs(BASE).catch(() => null)]);
  const gb = (n) => Math.round((n / 1073741824) * 10) / 10;
  return {
    cpuPct: cpu, memUsedMb: mem.used, memTotalMb: mem.total,
    diskUsedGb: st ? gb((st.blocks - st.bfree) * st.bsize) : 0, diskTotalGb: st ? gb(st.blocks * st.bsize) : 0,
    uptimeSec: Math.round(os.uptime()), load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    netInKbps: net.inKbps, netOutKbps: net.outKbps,
  };
}

/* ---------- helpers ---------- */
const readJson = async (f, fb) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return fb; } };
const slotFile = async (n) => { try { const s = (await fsp.readFile(path.join(BASE, 'deployment/state', n), 'utf8')).trim(); return SLOT_PORT[s] ? s : null; } catch { return null; } };
const activeSlot = async () => (await slotFile('active_slot')) || 'legacy';
const other = (s) => (s === 'legacy' ? 'blue' : s === 'blue' ? 'green' : 'blue');   // idle slot the next deploy will use
const standbySlot = async (active) => { const p = await slotFile('previous_slot'); return p && p !== active ? p : other(active); }; // = rollback target
const maintenanceOn = () => fs.existsSync(path.join(BASE, 'shared/maintenance.flag'));

function probe(port) { // GET /health(/ready) on a slot, 1.5s timeout, never throws (legacy :5000 only has /health)
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: port === 5000 ? '/health' : '/health/ready', timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; if (b.length > 4096) req.destroy(); });
      res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ healthy: res.statusCode === 200, release: j.release, commit: j.commit }); });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve({ healthy: false }));
  });
}

function runOps(args, timeoutMs = 120000) { // execFile = no shell, args are validated by callers
  return new Promise((resolve, reject) => {
    execFile(OPS, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout.trim())));
  });
}

/* ---------- overview ---------- */
async function pm2Status() {
  return cached('pm2', 4000, async () => {
    try { return JSON.parse(await runOps(['status'], 8000)); } catch (e) { logger.warn('infra: ops status failed', { error: e.message }); return { services: [], nginx: 'unknown' }; }
  });
}

async function dbInfo() {
  return cached('db', 30000, async () => {
    const out = { engine: 'MongoDB', status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', sizeGb: 0, connections: 0, maxConnections: 0, pgReady: false };
    try {
      const db = mongoose.connection.db;
      const st = await db.stats(); out.sizeGb = Math.round(((st.dataSize + st.indexSize) / 1073741824) * 100) / 100;
      const ss = await db.admin().serverStatus().catch(() => null);
      if (ss) { out.connections = ss.connections.current; out.maxConnections = ss.connections.current + ss.connections.available; }
    } catch { /* low-privilege db user: leave zeros */ }
    return out;
  });
}

async function history(limit = 50) {
  let txt = ''; try { txt = await fsp.readFile(path.join(BASE, 'deployment/history.jsonl'), 'utf8'); } catch { return []; }
  return txt.split('\n').filter(Boolean).slice(-limit * 2).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit).reverse();
}

async function overview(user) {
  return cached('overview', 3000, async () => {
    const [server, pm, db, active, hist, backup] = await Promise.all([
      serverStats(), pm2Status(), dbInfo(), activeSlot(), history(30), readJson(path.join(BASE, 'backups/status.json'), null),
    ]);
    const standby = await standbySlot(active);
    const [pa, ps] = await Promise.all([probe(SLOT_PORT[active]), probe(SLOT_PORT[standby])]);
    const live = hist.find((h) => h.status === 'success');
    const byName = Object.fromEntries((pm.services || []).map((s) => [s.name, s]));
    const roles = { 'sixstar-blue': 'API', 'sixstar-green': 'API', 'sixstar-pos': 'Legacy API + jobs', 'sixstar-worker': 'Background jobs', 'sixstar-staging': 'Staging API' };
    const services = [...SERVICES, 'sixstar-pos'].filter((n) => byName[n]).map((n) => {
      const s = byName[n]; const slot = n === 'sixstar-pos' ? 'legacy' : n.replace('sixstar-', '');
      return { ...s, role: roles[n] + (slot === active ? ' (live)' : slot === standby ? ' (standby)' : ''), port: SLOT_PORT[slot] || (n === 'sixstar-staging' ? 5200 : null) };
    });
    services.push({ name: 'nginx', role: 'Reverse proxy', status: pm.nginx === 'active' ? 'online' : 'offline', port: 443, memMb: 0, restarts: 0, uptimeSec: 0, release: null });
    const worker = byName['sixstar-worker'];
    return {
      maintenance: maintenanceOn(),
      github: { pendingApprovalUrl: process.env.INFRA_GITHUB_ACTIONS_URL || null },
      server,
      release: {
        active: { slot: active, releaseId: pa.release || live?.release || 'unknown', sha: (pa.commit || live?.sha || 'unknown').slice(0, 7), since: live?.ts || null, healthy: pa.healthy },
        standby: { slot: standby, releaseId: ps.release || 'none', sha: (ps.commit || 'none').slice(0, 7), healthy: ps.healthy },
      },
      services, database: db,
      backup: {
        lastSuccess: null, lastStatus: 'not_configured', r2Objects: 0, r2SizeGb: 0, retentionDays: 0, lastRestoreTest: null,
        restoreTestStatus: 'not run', encrypted: false, walStatus: 'not configured', ...(backup || {}),
      },
      jobs: { lockedBy: 'sixstar-worker', running: worker && worker.status === 'online' ? 12 : 0, lastFailure: null },
    };
  });
}

/* ---------- deployments ---------- */
async function deployments() {
  const items = (await history(50)).map((h) => ({ release: h.release, sha: h.sha, by: h.by, previous: h.previous, status: h.status, reason: h.reason || '', ts: h.ts, tests: h.tests || '-', health: h.health || '-' }));
  return { items };
}

/* ---------- logs (tail the PM2 files; parsed lines cached per file version) ---------- */
const ANSI = /\x1b\[[0-9;]*m/g;
const PM2_TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?):?\s+/;
function normLevel(l) { l = String(l || '').toLowerCase(); return l === 'error' || l === 'fatal' ? 'error' : l === 'warn' || l === 'warning' ? 'warn' : l === 'debug' || l === 'verbose' || l === 'silly' ? 'debug' : 'info'; }
function parseLines(text, service, isErrFile) {
  const out = [];
  for (let raw of text.split('\n')) {
    raw = raw.replace(ANSI, '').trimEnd(); if (!raw) continue;
    let ts = null; const m = raw.match(PM2_TS);
    if (m) { ts = Date.parse(m[1]); raw = raw.slice(m[0].length); }
    if (!m && out.length) { out[out.length - 1].msg += '\n' + raw; continue; } // stack-trace continuation
    let level = isErrFile ? 'error' : 'info', msg = raw;
    if (raw[0] === '{') {
      try {
        const j = JSON.parse(raw); const { level: lv, message, timestamp, stack, ...meta } = j;
        level = normLevel(lv); msg = String(message ?? '') + (Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '') + (stack ? '\n' + stack : '');
        if (timestamp && Number.isNaN(Date.parse(timestamp)) === false) ts = Date.parse(timestamp);
      } catch { /* plain text */ }
    } else if (/\b(error|exception|unhandled)\b/i.test(raw)) level = 'error';
    else if (/\bwarn(ing)?\b/i.test(raw)) level = 'warn';
    out.push({ ts: ts || 0, level, service, msg });
  }
  return out;
}
const fileCache = new Map();
async function tailFile(file, service, isErr, maxBytes = 262144) {
  let st; try { st = await fsp.stat(file); } catch { return []; }
  const key = file; const c = fileCache.get(key);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.lines;
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.min(st.size, maxBytes), buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    let text = buf.toString('utf8'); if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
    const lines = parseLines(text, service, isErr).map((l) => ({ ...l, ts: l.ts || Math.round(st.mtimeMs) }));
    fileCache.set(key, { size: st.size, mtime: st.mtimeMs, lines }); return lines;
  } finally { await fh.close(); }
}
async function logs({ service, level, q, after, limit }) {
  const names = service && SERVICES.includes(service) ? [service] : SERVICES;
  const files = names.flatMap((n) => { const s = n.replace('sixstar-', ''); return [[path.join(LOG_DIR, `${s}.out.log`), n, false], [path.join(LOG_DIR, `${s}.err.log`), n, true]]; });
  const all = (await Promise.all(files.map(([f, n, e]) => tailFile(f, n, e)))).flat().sort((a, b) => a.ts - b.ts);
  let last = -1, seq = 0;
  const withIds = all.map((l) => { seq = l.ts === last ? Math.min(seq + 1, 999) : 0; last = l.ts; return { id: l.ts * 1000 + seq, ts: new Date(l.ts).toISOString(), level: l.level, service: l.service, msg: l.msg }; });
  const min = RANK[level] ?? 0, needle = q ? String(q).toLowerCase() : '', a = Number(after) || 0;
  const lines = withIds.filter((l) => l.id > a && RANK[l.level] >= min && (!needle || (l.msg + l.service).toLowerCase().includes(needle)));
  return { lines: lines.slice(-(Math.min(Number(limit) || (a ? 500 : 300), 1000))) };
}

/* ---------- actions ---------- */
let busy = false;
async function act(user, action, body, ip) {
  if (busy) throw ApiError.badRequest('Another infrastructure action is running. Wait for it to finish.', 'INFRA_BUSY');
  busy = true;
  const audit = (status, detail) => fsp.appendFile(path.join(LOG_DIR, 'infra-audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), user: user.email || String(user._id), ip, action, detail, status }) + '\n').catch(() => {});
  try {
    let args, message;
    const active = await activeSlot();
    if (action === 'rollback') {
      const target = await standbySlot(active);
      const sb = await probe(SLOT_PORT[target]);
      if (!sb.healthy) throw ApiError.badRequest(`Rollback target (${target}) is not healthy - rollback refused. Nothing changed.`, 'STANDBY_UNHEALTHY');
      args = ['rollback']; message = `Rolled back to ${target} (verified through nginx).`;
    } else if (action === 'restart') {
      const svc = body.service;
      if (!SERVICES.includes(svc)) throw ApiError.badRequest('Unknown service', 'BAD_SERVICE');
      if (svc === `sixstar-${active}`) throw ApiError.badRequest('That is the LIVE API slot. Switch/rollback traffic first, then restart the idle slot.', 'LIVE_SLOT');
      args = ['restart', svc]; message = `${svc} restarted.`;
    } else if (action === 'backup') { args = ['backup']; message = 'Backup started. Check the Database & backups tab for the result.'; }
    else if (action === 'maintenance') { args = ['maintenance', body.enabled ? 'on' : 'off']; message = `Maintenance mode ${body.enabled ? 'ON' : 'OFF'}.`; }
    else throw ApiError.badRequest('Unknown action', 'BAD_ACTION');
    logger.warn('infra action', { action, args, by: user.email || String(user._id) });
    await audit('started', args.join(' '));
    try { await runOps(args); } catch (e) { await audit('failed', (e.stderr || e.message || '').slice(0, 300)); throw ApiError.badRequest(`Action failed: ${(e.stderr || e.message || '').slice(0, 200)}`, 'INFRA_ACTION_FAILED'); }
    await audit('ok', args.join(' ')); cache.clear();
    return { ok: true, message };
  } finally { busy = false; }
}

const canOperate = (user) => (process.env.INFRA_OPERATORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  .some((x) => x === String(user.email || '').toLowerCase() || x === String(user._id));

module.exports = { overview, deployments, logs, act, canOperate, parseLines, SERVICES };