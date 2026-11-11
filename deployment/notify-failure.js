#!/usr/bin/env node
/**
 * notify-failure.js - emails every SUPER ADMIN when a deployment fails (staging or production).
 * Run on the VPS by the GitHub workflow (the workflow copies this file over and runs it - nothing to install by hand).
 *
 * Input (environment variables, all set by the workflow):
 *   NF_ENV      staging | production        NF_STAGE   test | package | staging | production
 *   NF_RELEASE  release id (may be empty)   NF_SHA     git sha        NF_ACTOR  who pushed/pressed the button
 *   NF_RUN_URL  link to the GitHub run      NF_TEST=1  send a clearly-marked TEST email    NF_DRY_RUN=1  print, send nothing
 *
 * Recipients = active SUPER_ADMIN users that have an email in the production database  +  DEPLOY_ALERT_EMAILS (optional, comma list).
 * It only READS the production env file (Mongo URI + Brevo keys) inside this process and never prints any secret.
 * Exit code 0 = at least one email accepted by Brevo, 1 = nothing was sent.
 */
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), { createRequire } = require('module');

const B = process.env.SIXSTAR_BASE || '/var/www/sixstar-pos';
const e = (k, d = '') => String(process.env[k] || d).replace(/[\r\n]/g, ' ').slice(0, 300);
const ENVN = e('NF_ENV', 'production') === 'staging' ? 'staging' : 'production';
const STAGE = e('NF_STAGE', ENVN), REL = e('NF_RELEASE'), SHA = e('NF_SHA').slice(0, 40), ACTOR = e('NF_ACTOR', 'unknown'), RUN = e('NF_RUN_URL');
const TEST = process.env.NF_TEST === '1', DRY = process.env.NF_DRY_RUN === '1';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseEnv(file) { // minimal .env parser; returns {} if unreadable
  const out = {}; let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, ''); out[m[1]] = v; }
  return out;
}
const envFiles = [process.env.SIXSTAR_LEGACY_ENV || path.join(B, '.env'), path.join(B, 'shared/env/blue.env'), path.join(B, 'shared/env/green.env')];
const cfg = {}; for (const f of envFiles) Object.assign(cfg, Object.fromEntries(Object.entries(parseEnv(f)).filter(([k]) => !(k in cfg)))); // first file wins

function findModule(name) { // use whichever installed copy exists: legacy dir first, then newest releases
  const dirs = [B]; try { fs.readdirSync(path.join(B, 'releases')).map((d) => ({ d, t: fs.statSync(path.join(B, 'releases', d)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 6).forEach((x) => dirs.push(path.join(B, 'releases', x.d))); } catch { /* none */ }
  for (const d of dirs) { try { return createRequire(path.join(d, 'x.js'))(name); } catch { /* try next */ } }
  return null;
}

function lastHistory() { // what did the deploy script itself record for this release?
  if (!REL) return null; let txt = ''; try { txt = fs.readFileSync(path.join(B, 'deployment/history.jsonl'), 'utf8'); } catch { return null; }
  const rows = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.release === REL && ((r.env || 'production') === ENVN));
  return rows.length ? rows[rows.length - 1] : null;
}

function impact(h) {
  if (ENVN === 'staging') return { text: 'Production was NOT touched. Customers are unaffected.', urgent: false };
  const st = h && h.status;
  if (!st || st === 'failed_before_switch' || st === 'aborted_before_start') return { text: 'The live site stayed on the previous release. Customers are unaffected.', urgent: false };
  if (st === 'rolled_back_verified') return { text: 'The new release was switched in, failed its health check, and was rolled back automatically. The live site is on the previous release.', urgent: false };
  return { text: 'ACTION NEEDED NOW: the live site or worker may not be healthy (' + st + '). Open Admin > Infrastructure and check immediately.', urgent: true };
}

async function recipients() {
  const list = new Map();
  (cfg.DEPLOY_ALERT_EMAILS || process.env.DEPLOY_ALERT_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+$/.test(s)).forEach((m) => list.set(m, ''));
  const uri = cfg.MONGODB_URI || cfg.MONGO_URI || cfg.DATABASE_URL; const mongodb = uri && findModule('mongodb');
  if (mongodb) {
    let client; try {
      client = new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 6000 }); await client.connect();
      const users = await client.db().collection('users').find({ role: 'SUPER_ADMIN', email: { $type: 'string', $ne: '' }, status: { $nin: ['inactive', 'suspended', 'disabled', 'deleted'] } }, { projection: { email: 1, name: 1 } }).limit(50).toArray();
      users.forEach((u) => { if (/^[^@\s]+@[^@\s]+$/.test(u.email)) list.set(String(u.email).toLowerCase(), u.name || ''); });
    } catch (err) { console.error('could not read super admins from the database:', err.message); } finally { try { await client.close(); } catch { /* ignore */ } }
  } else console.error('database driver or Mongo URI not found - using DEPLOY_ALERT_EMAILS only');
  return [...list].map(([email, name]) => (name ? { email, name } : { email }));
}

function brevo(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request({ hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST', timeout: 15000, headers: { 'api-key': cfg.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: d.slice(0, 200) })); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); }); req.on('error', (err) => resolve({ ok: false, error: err.message })); req.end(body);
  });
}

(async () => {
  const h = lastHistory(); const imp = impact(h);
  const reason = (h && h.reason) || (STAGE === 'test' ? 'The automated tests failed - nothing was deployed.' : STAGE === 'package' ? 'Packaging the release failed - nothing was deployed.' : 'The deploy step failed before it could record a reason (for example the server could not be reached). Open the run for details.');
  const ENVLABEL = ENVN.toUpperCase();
  const subject = `${TEST ? '[TEST] ' : ''}${imp.urgent ? 'URGENT: ' : ''}Six Star POS deployment FAILED (${ENVLABEL})${REL ? ' - ' + REL : ''}`;
  const rows = [['Environment', ENVLABEL], ['Failed at', STAGE === 'test' ? 'Automated tests' : STAGE === 'package' ? 'Packaging' : STAGE === 'staging' ? 'Staging deploy' : 'Production deploy'], ['Release', REL || '-'], ['Commit', SHA || '-'], ['Started by', ACTOR], ['Reason', reason]];
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
    <div style="background:${imp.urgent ? '#7f1d1d' : '#b42318'};color:#fff;padding:16px 20px"><div style="font-size:12px;letter-spacing:.06em">${TEST ? 'TEST EMAIL - NOT A REAL FAILURE' : 'DEPLOYMENT FAILED'}</div><div style="font-size:20px;font-weight:700">&#10060; ${esc(ENVLABEL)} deployment failed</div></div>
    <div style="padding:18px 20px;color:#111827"><p style="margin:0 0 14px;padding:10px 12px;background:${imp.urgent ? '#fee2e2' : '#f3f4f6'};border-radius:8px"><b>${esc(imp.text)}</b></p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#6b7280;width:110px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;word-break:break-word">${esc(v)}</td></tr>`).join('')}</table>
    ${/^https:\/\/github\.com\//.test(RUN) ? `<p style="margin:16px 0 0"><a href="${esc(RUN)}" style="background:#111827;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;font-size:14px">Open the failed run</a></p>` : ''}
    <p style="margin:16px 0 0;font-size:12px;color:#6b7280">Admin &gt; Infrastructure &gt; Deployments shows the same failure with a red cross. Sent automatically to all super admins.</p></div></div>`;
  const text = `${TEST ? '[TEST] ' : ''}${ENVLABEL} deployment FAILED\n${imp.text}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${RUN ? '\nRun: ' + RUN : ''}`;

  const to = await recipients();
  console.log(`Recipients: ${to.length}${DRY ? ' -> ' + to.map((r) => r.email).join(', ') : ''}`);
  if (DRY) { console.log('SUBJECT:', subject, '\n' + text); return process.exit(0); }
  if (!to.length) { console.error('No super admin has an email address and DEPLOY_ALERT_EMAILS is empty - nobody to notify.'); return process.exit(1); }
  if (!cfg.BREVO_API_KEY || !cfg.BREVO_SENDER_EMAIL) { console.error('BREVO_API_KEY / BREVO_SENDER_EMAIL not found in the production env - email not sent.'); return process.exit(1); }
  const r = await brevo({ sender: { email: cfg.BREVO_SENDER_EMAIL, name: cfg.BREVO_SENDER_NAME || 'Six Star POS' }, to, subject, htmlContent: html, textContent: text, tags: ['deploy-failure', ENVN] });
  if (r.ok) { console.log('Failure email accepted by Brevo for', to.length, 'recipient(s).'); process.exit(0); }
  console.error('Brevo refused the email:', r.status || r.error, r.body || ''); process.exit(1);
})().catch((err) => { console.error('notify-failure crashed:', err.message); process.exit(1); });
