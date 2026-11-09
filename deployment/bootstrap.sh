#!/usr/bin/env bash
# deploy-staging.sh <release_id> <git_sha>   Touches ONLY sixstar-staging (:5200). Never nginx, never production, never sixstar-pos.
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); source "$HERE/lib.sh"
REL=${1:-}; SHA=${2:-}
[[ "$REL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$REL" != *..* ]] || { echo "invalid release id"; exit 2; }
[[ "$SHA" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "invalid git sha"; exit 2; }
DIR="$B/releases/$REL-staging"; ARCHIVE="$B/incoming/$REL.tar.gz"; PORT=5200
trap 'log "STAGING FAILED (line $LINENO) - production untouched"; exit 1' ERR

for c in node npm pm2 curl tar ss flock; do command -v "$c" >/dev/null || { echo "missing command: $c"; exit 1; }; done
for d in releases incoming shared/logs shared/env; do [ -d "$B/$d" ] && [ -w "$B/$d" ] || { echo "missing/unwritable $B/$d (run bootstrap.sh)"; exit 1; }; done
exec 8>"$B/deployment/state/.lock-staging"; flock -n 8 || { echo "another staging deploy is running"; exit 1; }
[ -s "$B/shared/env/staging.env" ] || { log "staging.env missing"; exit 1; }
for f in blue green; do [ -s "$B/shared/env/$f.env" ] || { log "missing $f.env (needed to prove staging is separate)"; exit 1; }; done
PROD=("$B/shared/env/blue.env" "$B/shared/env/green.env"); [ -f "$B/shared/env/worker.env" ] && PROD+=("$B/shared/env/worker.env"); [ -f "$LEGACY_ENV" ] && PROD+=("$LEGACY_ENV")
node "$HERE/envcheck.js" staging "$B/shared/env/staging.env" "${PROD[@]}" || { log "REFUSING staging deploy: unsafe configuration"; exit 1; }
msg=$(check_archive "$ARCHIVE") || { log "$msg"; exit 1; }

pm2_remove sixstar-staging
port_free "$PORT" || { log "port $PORT in use by something else"; exit 1; }
msg=$(extract_release "$ARCHIVE" "$DIR") || { log "$msg"; exit 1; }
ln -s "$B/shared/env/staging.env" "$DIR/.env"
msg=$(install_release "$DIR" 2>&1 | tail -3) || { log "$msg"; exit 1; }
export RELEASE_DIR="$DIR" RELEASE_ID="$REL" GIT_SHA="$SHA"
pm2_launch "$DIR/ecosystem.config.js" sixstar-staging
wait_slot "$PORT" "$READY_WAIT" "$REL" || { log "staging did not become ready"; exit 1; }
smoke_slot "$PORT" || { log "staging smoke test failed"; exit 1; }
log "staging OK ($REL)"