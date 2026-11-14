// NOTE: the legacy process "sixstar-pos" (:5000) is deliberately NOT defined here, so no pm2 command using this file can ever touch it.
// PM2 config. Each process reads its own env file via the .env symlink inside its release dir.
// Usage (done by deployment/deploy.sh): RELEASE_DIR=... RELEASE_ID=... GIT_SHA=... pm2 startOrReload ecosystem.config.js --only sixstar-green
const dir = process.env.RELEASE_DIR || __dirname;
const common = {
  cwd: dir,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  min_uptime: '20s',
  kill_timeout: 65000, // worker drain: 60s plus 5s PM2 margin
  max_memory_restart: `${restartMb}M`,
  merge_logs: true,
  time: true,
};
// only defined values: PM2 would otherwise pass the literal string "undefined"
const meta = {};
if (process.env.RELEASE_ID) meta.RELEASE_ID = process.env.RELEASE_ID;
if (process.env.GIT_SHA) meta.GIT_SHA = process.env.GIT_SHA;
const root = '/var/www/sixstar-pos/shared/logs';

// Adaptive limit written by `sixstar-mongoctl resources` (shared/resources.env). It can only RAISE the existing 350M restart limit after a VPS upgrade; it never lowers it.
let restartMb = 350;
try {
  const t = require('fs').readFileSync('/var/www/sixstar-pos/shared/resources.env', 'utf8');
  const m = t.match(/^PM2_MAX_MEMORY_RESTART_MB=(\d+)/m);
  if (m) restartMb = Math.max(350, Math.min(1024, parseInt(m[1], 10)));
} catch (e) { /* file not present yet: keep 350M */ }

module.exports = {
  apps: [
    { ...common, name: 'sixstar-blue', script: 'src/server.js', out_file: `${root}/blue.out.log`, error_file: `${root}/blue.err.log`,
      env: { NODE_ENV: 'production', PORT: 5100, APP_SLOT: 'blue', RUN_JOBS: 'false', ...meta } },
    { ...common, name: 'sixstar-green', script: 'src/server.js', out_file: `${root}/green.out.log`, error_file: `${root}/green.err.log`,
      env: { NODE_ENV: 'production', PORT: 5101, APP_SLOT: 'green', RUN_JOBS: 'false', ...meta } },
    { ...common, name: 'sixstar-worker', script: 'src/worker.js', out_file: `${root}/worker.out.log`, error_file: `${root}/worker.err.log`,
      env: { NODE_ENV: 'production', DOTENV_CONFIG_PATH: '/var/www/sixstar-pos/shared/env/worker.env', WORKER_READY_FILE: '/var/www/sixstar-pos/deployment/state/worker.ready', ...meta } },
    { ...common, name: 'sixstar-staging', script: 'src/server.js', out_file: `${root}/staging.out.log`, error_file: `${root}/staging.err.log`,
      env: { NODE_ENV: 'staging', PORT: 5200, APP_SLOT: 'staging', RUN_JOBS: 'false', ...meta } },
    // sixstar-staging-worker is intentionally NOT defined yet: add it only after SMS/PayHero mocks are verified.
  ],
};