#!/usr/bin/env bash
# install-mongodb.sh - install and secure MongoDB Community on the Six Star VPS (Ubuntu 24.04) WITHOUT touching production.
# Atlas stays the live database. After this script the new database is empty, authenticated, bound to 127.0.0.1 only, running as a single-node replica set,
# with adaptive resource settings, backups/monitoring scheduled and the dashboard wiring in place.
#
#   sudo bash install-mongodb.sh --db <production-db-name> [--app-user deploy] [--staging-db sixstar_staging] [--series 8.0] [--alert-email you@example.com] [--with-swap 2G]
#
# Safe to re-run: existing users, keys and env files are never overwritten.
set -Eeuo pipefail
trap 'echo "ERROR on line $LINENO - nothing in production was changed (Atlas is still live)." >&2' ERR

HERE=$(cd "$(dirname "$0")" && pwd)
BASE=${SIXSTAR_BASE:-/var/www/sixstar-pos}
ETC=/etc/sixstar
SERIES=8.0; DB=""; STG=sixstar_staging; APPUSER=""; ALERT=""; SWAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB=$2; shift 2 ;; --staging-db) STG=$2; shift 2 ;; --app-user) APPUSER=$2; shift 2 ;; --series) SERIES=$2; shift 2 ;;
    --alert-email) ALERT=$2; shift 2 ;; --with-swap) SWAP=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -n "$DB" ] || die "--db <production database name> is required (the database name in your Atlas MONGODB_URI)"
[[ "$DB" =~ ^[A-Za-z0-9_-]{1,38}$ && "$STG" =~ ^[A-Za-z0-9_-]{1,38}$ ]] || die "database names may contain only letters, digits, _ and -"
[ "$DB" != "$STG" ] || die "staging and production database names must differ"
. /etc/os-release
[ "${VERSION_CODENAME:-}" = noble ] || echo "WARNING: tested on Ubuntu 24.04 (noble); this is ${VERSION_CODENAME:-unknown}."
[ -d "$BASE" ] || die "$BASE not found"
[ -n "$APPUSER" ] || APPUSER=$(stat -c %U "$BASE")
id "$APPUSER" >/dev/null 2>&1 || die "app user '$APPUSER' does not exist"
APPGROUP=$(id -gn "$APPUSER")
export DEBIAN_FRONTEND=noninteractive

say "1/9 Packages (MongoDB $SERIES server, mongosh, database tools, age, zstd, rclone)"
apt-get update -qq
apt-get install -y -qq gnupg curl ca-certificates age zstd rclone python3 openssl >/dev/null
if ! dpkg -s mongodb-org-server >/dev/null 2>&1; then
  curl -fsSL "https://www.mongodb.org/static/pgp/server-${SERIES}.asc" | gpg --dearmor --yes -o "/usr/share/keyrings/mongodb-server-${SERIES}.gpg"
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${SERIES}.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/${SERIES} multiverse" > "/etc/apt/sources.list.d/mongodb-org-${SERIES}.list"
  apt-get update -qq
  apt-get install -y -qq mongodb-org-server mongodb-mongosh mongodb-database-tools >/dev/null
fi
apt-mark hold mongodb-org-server >/dev/null        # major upgrades only through a planned maintenance window (see the runbook)
systemctl stop mongod 2>/dev/null || true

if [ -n "$SWAP" ] && [ "$(swapon --show --noheadings | wc -l)" = 0 ]; then
  say "Swap file ($SWAP) - safety net against OOM kills"
  fallocate -l "$SWAP" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-sixstar-swap.conf; sysctl -q -p /etc/sysctl.d/99-sixstar-swap.conf
fi

say "2/9 Tooling and directories"
install -d -m 755 /usr/local/lib/sixstar-mongo
rm -rf /usr/local/lib/sixstar-mongo/sixstar_mongo
cp -r "$HERE/lib/sixstar_mongo" /usr/local/lib/sixstar-mongo/
find /usr/local/lib/sixstar-mongo -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
install -m 755 "$HERE/sixstar-mongoctl" /usr/local/sbin/sixstar-mongoctl
install -d -m 700 "$ETC" /var/lib/sixstar-mongo /var/backups/sixstar /var/backups/sixstar/staging /var/backups/sixstar/migration
install -d -m 755 /var/log/sixstar-mongo
install -d -m 2750 -o root -g "$APPGROUP" "$BASE/shared/db"       # setgid: files the root jobs write here stay readable by the app group (no secrets in here)
chmod g+s "$BASE/shared/db"

say "3/9 Encryption key for backups (age)"
if [ ! -f "$ETC/age-identity.txt" ]; then
  age-keygen -o "$ETC/age-identity.txt" 2>/dev/null; chmod 600 "$ETC/age-identity.txt"
  age-keygen -y "$ETC/age-identity.txt" > "$ETC/age-recipients.txt"; chmod 644 "$ETC/age-recipients.txt"
  NEWKEY=1
fi

say "4/9 mongod configuration (cache sized from the RAM this server really has)"
CACHE=$(SIXSTAR_BASE="$BASE" /usr/local/sbin/sixstar-mongoctl resources --print-cache-gb)
echo "WiredTiger cache: ${CACHE} GB"
install -d -o mongodb -g mongodb -m 750 /var/lib/mongodb /var/log/mongodb
write_conf() {  # $1 = 1 for the secured final config, 0 for the short bootstrap config (no auth, loopback only)
  cat > /etc/mongod.conf <<EOF
# Managed by Six Star install-mongodb.sh. cacheSizeGB is adjusted automatically by sixstar-mongoctl resources - do not hand-edit it.
storage:
  dbPath: /var/lib/mongodb
  wiredTiger:
    engineConfig:
      cacheSizeGB: ${CACHE}
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
  logRotate: reopen
net:
  port: 27017
  bindIp: 127.0.0.1
  ipv6: false
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
replication:
  replSetName: rs0
  oplogSizeMB: 1024
operationProfiling:
  slowOpThresholdMs: 200
EOF
  if [ "$1" = 1 ]; then cat >> /etc/mongod.conf <<EOF
security:
  authorization: enabled
  keyFile: /etc/mongodb-keyfile
setParameter:
  enableLocalhostAuthBypass: false
EOF
  fi
  chmod 644 /etc/mongod.conf
}
[ -f /etc/mongodb-keyfile ] || { openssl rand -base64 756 > /etc/mongodb-keyfile; }
chown mongodb:mongodb /etc/mongodb-keyfile; chmod 400 /etc/mongodb-keyfile

install -d /etc/systemd/system/mongod.service.d
cat > /etc/systemd/system/mongod.service.d/sixstar.conf <<'EOF'
[Unit]
StartLimitIntervalSec=900
StartLimitBurst=6
[Service]
Restart=on-failure
RestartSec=5
OOMScoreAdjust=-900
EOF
for u in $(systemctl list-unit-files 'pm2-*.service' --no-legend 2>/dev/null | awk '{print $1}'); do   # PM2 must start after the database after a reboot
  install -d "/etc/systemd/system/$u.d"
  printf '[Unit]\nAfter=mongod.service\nWants=mongod.service\n' > "/etc/systemd/system/$u.d/10-sixstar-mongod.conf"
done
systemctl daemon-reload

say "5/9 First start, replica set and users (loopback only, no auth for ~1 minute)"
mongo_wait() { for _ in $(seq 1 60); do mongosh --quiet --norc "$1" --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
if [ ! -s "$ETC/mongo-admin.env" ]; then
  PW_ADMIN=$(openssl rand -hex 24); PW_OPS=$(openssl rand -hex 24); PW_APP=$(openssl rand -hex 24); PW_STG=$(openssl rand -hex 24)
  write_conf 0
  systemctl enable --now mongod
  mongo_wait mongodb://127.0.0.1:27017/admin || die "mongod did not start: journalctl -u mongod -n 50"
  mongosh --quiet --norc mongodb://127.0.0.1:27017/admin --eval 'try{rs.status()}catch(e){rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})}' >/dev/null
  for _ in $(seq 1 30); do [ "$(mongosh --quiet --norc mongodb://127.0.0.1:27017/admin --eval 'db.hello().isWritablePrimary')" = true ] && break; sleep 2; done
  PW_ADMIN=$PW_ADMIN PW_OPS=$PW_OPS PW_APP=$PW_APP PW_STG=$PW_STG DB=$DB STG=$STG mongosh --quiet --norc mongodb://127.0.0.1:27017/admin --eval '
    const A = process.env, adm = db.getSiblingDB("admin");
    adm.createUser({user:"sixstar_admin", pwd:A.PW_ADMIN, roles:[{role:"root", db:"admin"}]});
    adm.createUser({user:"sixstar_ops", pwd:A.PW_OPS, roles:[{role:"backup",db:"admin"},{role:"clusterMonitor",db:"admin"},{role:"hostManager",db:"admin"},{role:"readAnyDatabase",db:"admin"}]});
    db.getSiblingDB(A.DB).createUser({user:"sixstar_app", pwd:A.PW_APP, roles:[{role:"readWrite", db:A.DB}]});
    db.getSiblingDB(A.STG).createUser({user:"sixstar_staging_app", pwd:A.PW_STG, roles:[{role:"readWrite", db:A.STG}]});' >/dev/null
  RS="replicaSet=rs0"
  ( umask 077
    cat > "$ETC/mongo-admin.env" <<EOF
# root only. Used by the migration / restore tools. NEVER copy into app env files, GitHub or the frontend.
MONGO_ADMIN_URI=mongodb://sixstar_admin:${PW_ADMIN}@127.0.0.1:27017/admin?${RS}&authSource=admin
APP_MONGODB_URI=mongodb://sixstar_app:${PW_APP}@127.0.0.1:27017/${DB}?${RS}&authSource=${DB}&retryWrites=true&w=majority
STAGING_MONGODB_URI=mongodb://sixstar_staging_app:${PW_STG}@127.0.0.1:27017/${STG}?${RS}&authSource=${STG}&retryWrites=true&w=majority
PROD_DB=${DB}
EOF
    [ -f "$ETC/mongo-ops.env" ] || cat > "$ETC/mongo-ops.env" <<EOF
# root only - read by the guardian / backup jobs (independent of Node and of the dashboard)
MONGO_OPS_URI=mongodb://sixstar_ops:${PW_OPS}@127.0.0.1:27017/admin?${RS}&authSource=admin
SERVER_NAME=Six Star VPS
ALERT_EMAILS=${ALERT}
# Cloudflare R2 (S3 API). Create an API token limited to the bucket sixstar-pos-backups (Object Read & Write).
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
# Alert e-mail goes straight to Brevo so it works even when MongoDB or Node are down (same sender as the POS).
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=Six Star POS
EOF
    [ -f "$ETC/migration.env" ] || cp "$HERE/env/migration.env.example" "$ETC/migration.env"
    [ -f "$ETC/backup.json" ] || cp "$HERE/env/backup.json.example" "$ETC/backup.json" )
  chmod 600 "$ETC"/*.env "$ETC/backup.json"
  systemctl stop mongod
else
  echo "Users already exist - keeping them."
fi
write_conf 1
systemctl enable mongod >/dev/null
systemctl restart mongod

say "6/9 Verify security"
OPS_URI=$(grep '^MONGO_OPS_URI=' "$ETC/mongo-ops.env" | cut -d= -f2-)
mongo_wait "$OPS_URI" || die "mongod is up but the ops login failed: journalctl -u mongod -n 50"
OPEN=$(mongosh --quiet --norc mongodb://127.0.0.1:27017/admin --eval 'try{db.adminCommand({listDatabases:1});print("OPEN")}catch(e){print("DENIED")}' | tail -1)
[ "$OPEN" = DENIED ] || die "MongoDB accepts unauthenticated commands - aborting"
if ss -ltnH | awk '{print $4}' | grep -E ':27017$' | grep -vE '^(127\.0\.0\.1|\[::1\]):27017$' >/dev/null; then die "port 27017 is listening on a public address"; fi
command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active' && ufw deny 27017/tcp >/dev/null 2>&1 || true
echo "OK: authentication enforced, listening on 127.0.0.1 only, replica set rs0."

say "7/9 Scheduled jobs, log rotation, dashboard permissions"
install -m 644 "$HERE/cron-sixstar-mongo" /etc/cron.d/sixstar-mongo
install -m 644 "$HERE/logrotate-sixstar-mongo" /etc/logrotate.d/sixstar-mongo
sed "s/__APP_USER__/${APPUSER}/g" "$HERE/sudoers-sixstar-mongo" > /tmp/sixstar-sudoers.$$
visudo -cf /tmp/sixstar-sudoers.$$ >/dev/null || die "generated sudoers file is invalid"
install -m 440 -o root -g root /tmp/sixstar-sudoers.$$ /etc/sudoers.d/sixstar-mongo; rm -f /tmp/sixstar-sudoers.$$
if [ -f "$HERE/../sixstar-ops.sh" ]; then
  [ -f /usr/local/bin/sixstar-ops ] && cp -n /usr/local/bin/sixstar-ops /usr/local/bin/sixstar-ops.pre-mongo.bak
  install -o root -g root -m 755 "$HERE/../sixstar-ops.sh" /usr/local/bin/sixstar-ops
fi

say "8/9 Resource engine, first health pass, transaction test"
/usr/local/sbin/sixstar-mongoctl resources | head -25 || true
/usr/local/sbin/sixstar-mongoctl guardian || true
/usr/local/sbin/sixstar-mongoctl txn-test || echo "WARNING: transaction test failed - do not cut over until it passes."

say "9/9 Done. MongoDB Community is installed but NOT used by the POS yet (Atlas is still live)."
cat <<EOF

NEXT STEPS (full detail in deployment/mongo/MIGRATION-RUNBOOK.md)
 1. Fill in Cloudflare R2 + Brevo values:        sudo nano $ETC/mongo-ops.env
 2. Put the Atlas connection string in:           sudo nano $ETC/migration.env   (ATLAS_URI=...)  and allow this VPS IP in Atlas > Network Access
 3. Prove backups work:                            sudo sixstar-mongoctl backup full --manual && sudo sixstar-mongoctl verify latest
 4. Start the migration:                           sudo sixstar-mongoctl migrate audit
EOF
if [ "${NEWKEY:-0}" = 1 ]; then cat <<EOF

 !!! COPY THIS FILE OFF THE SERVER NOW (password manager / offline): $ETC/age-identity.txt
 !!! Backups are encrypted with it. If the VPS is lost and you do not have a copy, the R2 backups CANNOT be decrypted.
EOF
fi
