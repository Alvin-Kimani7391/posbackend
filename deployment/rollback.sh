#!/usr/bin/env bash
# rollback.sh - send traffic back to the PREVIOUS slot (can be "legacy"). Never touches the database or stops anything.
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); source "$HERE/lib.sh"
T=$(read_slot_file "$PREV") || die "no previous slot recorded yet - nothing to roll back to (use promote.sh <slot> if you know what you want)"
exec bash "$HERE/promote.sh" "$T" "${USER:-unknown}-rollback"