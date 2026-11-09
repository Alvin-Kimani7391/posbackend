#!/usr/bin/env bash
# deploy.sh <release_id> <git_sha> [initiator] [--no-switch]
#   Builds the release in the IDLE slot (legacy->blue, blue->green, green->blue), verifies it, then switches nginx.
#   --no-switch : stop after the candidate is verified; production traffic is NOT touched (test it on :5100/:5101).
# This script NEVER stops, restarts or deletes the live slot or the legacy process "sixstar-pos".
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); source "$HERE/lib.sh"

NOSWITCH=0; ARGS=()
for a in "$@"; do if [ "$a" = "--no-switch" ]; then NOSWITCH=1; else ARGS+=("$a"); fi; done
REL=${ARGS[0]:-}; SHA=${ARGS[1]:-}; BY=$(clean "${ARGS[2]:-unknown}")
[[ "$REL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$REL" != *..* ]] || { echo "invalid release id"; exit 2; }
[[ "$SHA" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "invalid git sha"; exit 2; }

ACTIVE=unknown; CAND=""; PHASE=pre; STANDBY_INFO=""
abort() { trap - ERR; log "ABORTED, nothing was changed: $1"; record "$REL" "$SHA" "$BY" "$ACTIVE" "aborted_before_start" "$1" || true; exit 1; }
fail()  { trap - ERR; log "FAILED: $1 - production still on $ACTIVE"; if [ -n "$CAND" ]; then pm2_remove "sixstar-$CAND"; restore_proc "sixstar-$CAND" "$STANDBY_INFO"; fi   # put the previous standby (rollback target) back
          record "$REL" "$SHA" "$BY" "$ACTIVE" "failed_before_switch" "$1" || true; exit 1; }
on_err() { local l=$1; if [ "$PHASE" = pre ]; then abort "unexpected error (line $l)"; else fail "unexpected error (line $l)"; fi; }
trap 'on_err $LINENO' ERR

exec 8>"$STATE_DIR/.lock"; flock -n 8 || { echo "another deploy/rollback is running"; exit 1; }

# ---------- 1. verify everything before touching anything ----------
msg=$(preflight_common) || abort "$msg"
ACTIVE=$(read_slot_file "$STATE") || abort "active_slot is missing or invalid (expected legacy|blue|green)"
CAND=$(other "$ACTIVE"); CPORT=$(port_of "$CAND"); DIR="$B/releases/$REL"; ARCHIVE="$B/incoming/$REL.tar.gz"
drift_check "$ACTIVE" || abort "nginx upstream (port $(upstream_port)) does not match active_slot=$ACTIVE - resolve manually"
wait_slot "$(port_of "$ACTIVE")" 5 || abort "live slot '$ACTIVE' is not healthy - refusing to deploy on top of it"

for f in blue green; do [ -s "$B/shared/env/$f.env" ] || abort "missing shared/env/$f.env"; done
PENVS=("$B/shared/env/blue.env" "$B/shared/env/green.env")
if [ -f "$WFLAG" ]; then
  [ -s "$B/shared/env/worker.env" ] || abort "worker is enabled but shared/env/worker.env is missing"
  PENVS+=("$B/shared/env/worker.env")
  if pm2_online sixstar-pos; then abort "worker enabled, but the legacy process sixstar-pos is still running its own jobs (would duplicate SMS/billing/M-Pesa). Stop it yourself first: pm2 stop sixstar-pos"; fi
fi
LEG=(); [ -f "$LEGACY_ENV" ] && LEG=(--legacy "$LEGACY_ENV")
node "$HERE/envcheck.js" production "${PENVS[@]}" "${LEG[@]}" || abort "environment check failed (see messages above)"
msg=$(check_archive "$ARCHIVE") || abort "$msg"
[ ! -e "$DIR" ] || abort "release directory already exists"

# ---------- 2. build the candidate in a NEW release directory ----------
PHASE=start
STANDBY_INFO=$(proc_info "sixstar-$CAND")                    # remembered so a failed deploy can restore it
pm2_remove "sixstar-$CAND"                                   # the IDLE slot only (its release directory is kept)
port_free "$CPORT" || fail "port $CPORT is in use by something else"
msg=$(extract_release "$ARCHIVE" "$DIR") || fail "$msg"
ln -s "$B/shared/env/$CAND.env" "$DIR/.env"
[ -e "$DIR/uploads" ] || ln -s "$B/shared/uploads" "$DIR/uploads"
msg=$(install_release "$DIR" 2>&1 | tail -3) || fail "dependency install/sanity: $msg"

# ---------- 3. start + verify the idle slot (production untouched) ----------
export RELEASE_DIR="$DIR" RELEASE_ID="$REL" GIT_SHA="$SHA"
pm2_launch "$DIR/ecosystem.config.js" "sixstar-$CAND"
wait_slot "$CPORT" "$READY_WAIT" "$REL" || fail "candidate /health/ready did not report release $REL within ${READY_WAIT}s"
body=$(curl -fsS -m 5 "http://127.0.0.1:$CPORT/health") || fail "candidate /health unreachable"
grep -q "\"slot\":\"$CAND\"" <<<"$body" || fail "candidate reports the wrong slot"
smoke_slot "$CPORT" || fail "candidate failed the critical-route smoke test"
log "candidate $CAND verified on :$CPORT (release $REL)"

if [ "$NOSWITCH" = 1 ]; then
  record "$REL" "$SHA" "$BY" "$ACTIVE" "candidate_verified_not_switched" "--no-switch"
  log "DONE (no switch). Production still on $ACTIVE. Test: curl http://127.0.0.1:$CPORT/health/ready  |  promote: bash $HERE/promote.sh $CAND"
  exit 0
fi

# ---------- 4. switch traffic through nginx, verify end-to-end, auto-restore on failure ----------
trap - ERR; set +e
switch_and_verify "$CAND" "$ACTIVE"; rc=$?
PHASE=switched
if [ $rc -ne 0 ]; then
  [ $rc -eq 3 ] && st="ROLLBACK_FAILED_MANUAL_ACTION" || st="rolled_back_verified"
  record "$REL" "$SHA" "$BY" "$ACTIVE" "$st" "$SWITCH_ERR"; log "$SWITCH_ERR"
  if [ $rc -eq 2 ]; then pm2_remove "sixstar-$CAND"; restore_proc "sixstar-$CAND" "$STANDBY_INFO"; fi   # failed release DIRECTORY is kept for inspection; previous standby restored
  exit 1
fi
log "traffic is now on $CAND"

# ---------- 5. worker handover - ONLY if explicitly enabled (state/worker_enabled) ----------
if [ -f "$WFLAG" ]; then
  OLD=$(worker_info); rm -f "$WREADY"
  pm2_halt sixstar-worker; pm2_remove sixstar-worker          # graceful SIGTERM (15s), then start the new one: never two at once
  pm2_launch "$DIR/ecosystem.config.js" sixstar-worker
  if wait_worker "$REL" 60; then log "worker verified for $REL"
  else
    log "NEW WORKER FAILED - restoring previous worker"; pm2_remove sixstar-worker; rm -f "$WREADY"; ST=WORKER_DOWN_MANUAL_ACTION
    if [ -n "$OLD" ]; then
      IFS='|' read -r OCWD OREL OSHA <<< "$OLD"
      if [ -f "$OCWD/ecosystem.config.js" ]; then
        ( export RELEASE_DIR="$OCWD" RELEASE_ID="$OREL" GIT_SHA="$OSHA"; pm2_launch "$OCWD/ecosystem.config.js" sixstar-worker ); sleep 20
        pm2_online sixstar-worker && ST=worker_failed_old_worker_restored
      fi
    fi
    record "$REL" "$SHA" "$BY" "$ACTIVE" "$ST" "new worker did not become ready"; log "API is live on $CAND but worker status = $ST. CHECK NOW."; exit 1
  fi
fi
pm2 save >/dev/null 2>&1
record "$REL" "$SHA" "$BY" "$ACTIVE" "success" ""
log "SUCCESS: $CAND is live ($REL). Previous slot '$ACTIVE' is untouched and still running for instant rollback."