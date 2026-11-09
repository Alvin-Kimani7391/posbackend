#!/usr/bin/env bash
# promote.sh <legacy|blue|green>  - switch live traffic to an ALREADY RUNNING, healthy slot (verified through nginx).
# Used by rollback.sh and for promoting a candidate that was deployed with --no-switch. Never stops any process.
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); source "$HERE/lib.sh"
TARGET=${1:-}; BY=$(clean "${2:-${USER:-unknown}}")
valid_slot "$TARGET" || { echo "usage: promote.sh <legacy|blue|green>"; exit 2; }
exec 8>"$STATE_DIR/.lock"; flock -n 8 || { echo "another deploy/rollback is running"; exit 1; }
msg=$(preflight_common) || die "$msg"
ACTIVE=$(read_slot_file "$STATE") || die "active_slot is missing or invalid"
[ "$TARGET" != "$ACTIVE" ] || die "$TARGET is already live"
drift_check "$ACTIVE" || die "nginx upstream does not match active_slot=$ACTIVE - resolve manually"
wait_slot "$(port_of "$TARGET")" 10 || die "slot $TARGET is not healthy on :$(port_of "$TARGET"). Nothing changed."
set +e; switch_and_verify "$TARGET" "$ACTIVE"; rc=$?; set -e
case $rc in
  0) record "promote:$TARGET" "-" "$BY" "$ACTIVE" "promote_verified" ""; log "Traffic is on $TARGET (verified through nginx). Previous: $ACTIVE" ;;
  2) record "promote:$TARGET" "-" "$BY" "$ACTIVE" "promote_failed_restored" "$SWITCH_ERR"; die "$SWITCH_ERR" ;;
  *) record "promote:$TARGET" "-" "$BY" "$ACTIVE" "ROLLBACK_FAILED_MANUAL_ACTION" "$SWITCH_ERR"; die "$SWITCH_ERR" ;;
esac