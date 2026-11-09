# lib.sh - shared helpers for the Blue/Green scripts. SOURCED by the other scripts, never run directly.
# Slots: legacy = the original single process "sixstar-pos" on :5000 | blue = :5100 | green = :5101
# The scripts only ever touch: sixstar-blue, sixstar-green, sixstar-worker, sixstar-staging. NEVER sixstar-pos.

B=${SIXSTAR_BASE:-/var/www/sixstar-pos}
DOMAIN=${SIXSTAR_DOMAIN:-pos-api.sixstarsuppliers.com}
NGX_UP=${SIXSTAR_NGX_UP:-/etc/nginx/sixstar-active-upstream.conf}
LEGACY_ENV=${SIXSTAR_LEGACY_ENV:-$B/.env}                   # read-only: only ever READ, for comparison
STATE_DIR=$B/deployment/state
STATE=$STATE_DIR/active_slot
PREV=$STATE_DIR/previous_slot
HIST=$B/deployment/history.jsonl
WREADY=$STATE_DIR/worker.ready
WFLAG=$STATE_DIR/worker_enabled
NGX_BIN=${SIXSTAR_NGINX_BIN:-/usr/sbin/nginx}
SYSTEMCTL_BIN=${SIXSTAR_SYSTEMCTL_BIN:-/usr/bin/systemctl}
READY_WAIT=${SIXSTAR_READY_WAIT:-60}      # seconds a new slot gets to become ready
VERIFY_GAP=${SIXSTAR_VERIFY_GAP:-3}       # seconds between the 5 post-switch checks

log()  { echo "[$(date -u +%FT%TZ)] $*"; }
die()  { log "ERROR: $*"; exit 1; }
clean() { printf '%s' "${1:-}" | tr -d '"\\\r\n\t' | cut -c1-200; }            # safe to embed in a JSON string
record() { # record <release> <sha> <initiator> <previous> <status> <reason>
  printf '{"ts":"%s","release":"%s","sha":"%s","by":"%s","previous":"%s","status":"%s","reason":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$(clean "$1")" "$(clean "$2")" "$(clean "$3")" "$(clean "$4")" "$(clean "$5")" "$(clean "$6")" >> "$HIST"; }
write_state() { printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"; }         # atomic

valid_slot() { case "${1:-}" in legacy|blue|green) return 0 ;; *) return 1 ;; esac; }
port_of() { case "${1:-}" in blue) echo 5100 ;; green) echo 5101 ;; legacy) echo 5000 ;; *) return 1 ;; esac; }
other()   { case "${1:-}" in legacy) echo blue ;; blue) echo green ;; green) echo blue ;; *) return 1 ;; esac; }   # first deploy from legacy -> blue; then alternate
read_slot_file() { local s; s=$(tr -d '[:space:]' < "$1" 2>/dev/null || true); valid_slot "$s" && echo "$s"; }

# pm2 may start its daemon (and every app) from inside our call: never let it inherit the deploy lock (fd 8)
pm2() { command pm2 "$@" 8>&-; }

# ---- the only pm2 verbs the scripts may use, and only on managed names ----
managed() { case "${1:-}" in sixstar-blue|sixstar-green|sixstar-worker|sixstar-staging) return 0 ;; *) return 1 ;; esac; }
pm2_remove() { managed "$1" || die "REFUSING to touch pm2 process '$1'"; pm2 delete "$1" >/dev/null 2>&1 || true; }
pm2_halt()   { managed "$1" || die "REFUSING to touch pm2 process '$1'"; pm2 stop "$1" >/dev/null 2>&1 || true; }
pm2_launch() { managed "$2" || die "REFUSING to touch pm2 process '$2'"; pm2 start "$1" --only "$2" >/dev/null; }   # <ecosystem> <name>
pm2_online() { pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s.slice(s.indexOf("[")));process.exit(p.some(x=>x.name===process.argv[1]&&x.pm2_env.status==="online")?0:1)}catch(e){process.exit(1)}})' "$1"; }
proc_info() { # proc_info <name> -> "cwd|release|sha" of a registered pm2 process, or nothing
  pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s.slice(s.indexOf("["))).find(x=>x.name===process.argv[1]);if(p)console.log([p.pm2_env.pm_cwd,p.pm2_env.RELEASE_ID||"",p.pm2_env.GIT_SHA||""].join("|"))}catch(e){}})' "$1"; }
worker_info() { proc_info sixstar-worker; }
restore_proc() { # restore_proc <name> <"cwd|release|sha">  best effort: bring a replaced process back from ITS OWN (kept) release dir
  local name=$1 info=${2:-} cwd rel sha
  [ -n "$info" ] || return 0
  IFS='|' read -r cwd rel sha <<< "$info"
  [ -f "$cwd/ecosystem.config.js" ] || return 0
  ( export RELEASE_DIR="$cwd" RELEASE_ID="$rel" GIT_SHA="$sha"; pm2_launch "$cwd/ecosystem.config.js" "$name" ) || true
}

# ---- preflight: verify everything BEFORE anything is modified ----
preflight_common() {
  local c f
  for c in node npm pm2 curl tar sha256sum ss flock df; do command -v "$c" >/dev/null 2>&1 || { echo "missing command: $c"; return 1; }; done
  [ -x "$NGX_BIN" ] || { echo "missing $NGX_BIN"; return 1; }
  for f in releases incoming deployment/state shared/logs shared/env; do [ -d "$B/$f" ] && [ -w "$B/$f" ] || { echo "missing or unwritable: $B/$f (run bootstrap.sh)"; return 1; }; done
  [ -w "$HIST" ] || { echo "history file not writable: $HIST"; return 1; }
  [ -f "$NGX_UP" ] && [ -w "$NGX_UP" ] || { echo "upstream file missing/unwritable: $NGX_UP (install nginx/install-upstream.sh first)"; return 1; }
  [ "$(df -Pk "$B" | awk 'NR==2{print $4}')" -gt 1500000 ] || { echo "less than 1.5 GB free disk"; return 1; }
  sudo -n "$NGX_BIN" -t >/dev/null 2>&1 || { echo "nginx -t fails right now (or sudoers rule missing) - fix nginx first"; return 1; }
  return 0
}
upstream_port() { sed -n 's/.*server[[:space:]]\+127\.0\.0\.1:\([0-9]\+\).*/\1/p' "$NGX_UP" | head -1; }
drift_check()   { [ "$(upstream_port)" = "$(port_of "$1")" ]; }   # nginx must really point where active_slot says

# ---- health ----
slot_probe() { # slot_probe <port> [expected_release]  (legacy :5000 only has /health)
  local p=/health/ready body; [ "$1" = 5000 ] && p=/health
  body=$(curl -fsS -m 3 "http://127.0.0.1:$1$p" 2>/dev/null) || return 1
  [ -z "${2:-}" ] || grep -q "\"release\":\"$2\"" <<<"$body"
}
wait_slot() { local i; for i in $(seq 1 "$2"); do slot_probe "$1" "${3:-}" && return 0; sleep 1; done; return 1; }
smoke_slot() { # critical routes respond sanely (no crash, no 5xx): unknown route -> 404, empty login -> 4xx validation
  local port=$1 c
  c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port/api/v1/__smoke_nonexistent") || return 1; [ "$c" = 404 ] || return 1
  c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/v1/auth/login") || return 1
  case "$c" in 400|401|422|429) return 0 ;; *) return 1 ;; esac
}
verify_via_nginx() { # the REAL path: https://domain -> nginx -> upstream -> slot
  local slot=$1 body
  body=$(curl -fsS -m 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" 2>/dev/null) || return 1
  [ "$slot" = legacy ] && return 0
  grep -q "\"slot\":\"$slot\"" <<<"$body"
}

# ---- nginx switch: backup -> write -> nginx -t -> reload; restore on ANY failure ----
switch_nginx() { # switch_nginx <slot>
  local slot=$1 bak port
  port=$(port_of "$slot") || return 1
  bak="$B/backups/nginx/upstream.$(date +%s).conf"; mkdir -p "$B/backups/nginx"
  cp "$NGX_UP" "$bak" || return 1
  printf 'upstream sixstar_active { server 127.0.0.1:%s; }\n' "$port" > "$NGX_UP"
  if sudo -n "$NGX_BIN" -t >/dev/null 2>&1 && sudo -n "$SYSTEMCTL_BIN" reload nginx >/dev/null 2>&1; then
    write_state "$STATE" "$slot"; return 0
  fi
  cp "$bak" "$NGX_UP"; return 1
}
# switch + verify through nginx; on failure put traffic back on <prev> and verify THAT. Returns 0 ok | 2 restored | 3 restore unverified
switch_and_verify() { # switch_and_verify <target> <prev>
  local target=$1 prev=$2 i ok=1
  SWITCH_ERR=""
  if ! switch_nginx "$target"; then SWITCH_ERR="nginx switch/validation failed; previous upstream restored"; return 2; fi
  sleep "$VERIFY_GAP"
  for i in 1 2 3 4 5; do verify_via_nginx "$target" || { ok=0; break; }; sleep "$VERIFY_GAP"; done
  if [ "$ok" = 1 ]; then write_state "$PREV" "$prev"; return 0; fi
  log "post-switch verification FAILED - restoring $prev"
  if wait_slot "$(port_of "$prev")" 15 && switch_nginx "$prev" && sleep "$VERIFY_GAP" && verify_via_nginx "$prev"; then
    SWITCH_ERR="post-switch verification failed; traffic restored to $prev (verified)"; return 2
  fi
  SWITCH_ERR="post-switch verification failed AND restoring $prev could NOT be verified - manual action needed"; return 3
}

# ---- release archives ----
check_archive() { # structural checks BEFORE extracting anything (no "cmd | grep -q": SIGPIPE + pipefail would hide matches)
  local a=$1 list norm need
  [ -f "$a" ] && [ -s "$a" ] || { echo "release archive missing or empty: $a"; return 1; }
  list=$(tar -tzf "$a" 2>/dev/null) || { echo "archive is not a valid .tar.gz"; return 1; }
  norm=$(sed 's#^\./##' <<<"$list")
  if grep -qE '(^/|(^|/)\.\.(/|$))' <<<"$norm"; then echo "archive has absolute or '..' paths"; return 1; fi
  if grep -qE '(^|/)\.env(\.(local|production|staging|development))?$' <<<"$norm"; then echo "archive contains an .env file"; return 1; fi
  for need in package.json package-lock.json ecosystem.config.js src/server.js src/worker.js; do
    grep -qx "$need" <<<"$norm" || { echo "archive is missing $need"; return 1; }
  done
  return 0
}
extract_release() { # extract_release <archive> <final_dir>  (extract to a temp dir, then rename: no half-built releases)
  local a=$1 dest=$2 tmp
  tmp="$(dirname "$dest")/.tmp-$(basename "$dest")"
  [ ! -e "$tmp" ] && [ ! -e "$dest" ] || { echo "release directory already exists (releases are immutable)"; return 1; }
  mkdir "$tmp"
  if tar -xzf "$a" -C "$tmp" --no-same-owner --no-same-permissions; then mv "$tmp" "$dest"; else rm -rf -- "$tmp"; echo "extract failed"; return 1; fi
}
install_release() { # npm ci + sanity, inside the NEW release dir only
  local d=$1
  ( cd "$d" && CI=true timeout 900 npm ci --omit=dev --no-audit --no-fund ) || { echo "npm ci failed"; return 1; }
  ( cd "$d" && node --check src/server.js && node --check src/worker.js && test -d node_modules/mongoose ) || { echo "release sanity check failed"; return 1; }
}
port_free() { local o; o=$(ss -ltn "( sport = :$1 )" 2>/dev/null || true); ! grep -q LISTEN <<<"$o"; }

wait_worker() { # wait_worker <release> <seconds>: worker proved DB connected AND every job started, for THIS release
  local i pid
  for i in $(seq 1 "$2"); do
    if [ -s "$WREADY" ] && grep -q "\"release\":\"$1\"" "$WREADY"; then
      pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$WREADY"); kill -0 "$pid" 2>/dev/null && pm2_online sixstar-worker && return 0
    fi
    sleep 1
  done; return 1
}