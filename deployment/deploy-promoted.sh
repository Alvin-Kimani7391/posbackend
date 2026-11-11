#!/usr/bin/env bash
# deploy-promoted.sh <release_id> [initiator]
# Production deploy of the EXACT tarball that already passed staging. Refuses anything else.
# Checks: release has a successful STAGING record in history, tarball still matches the sha256 saved at staging time,
# and it has not been deployed to production already. Then hands over to deploy.sh (all its safety checks apply).
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); source "$HERE/lib.sh"
REL=${1:-}; BY=$(clean "${2:-unknown}")
[[ "$REL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$REL" != *..* ]] || { echo "invalid release id"; exit 2; }
ARCHIVE="$B/incoming/$REL.tar.gz"; SUMFILE="$B/incoming/$REL.sha256"
[ -s "$HIST" ] || { echo "no deployment history"; exit 1; }
STG=$(grep -F "\"release\":\"$REL\"" "$HIST" | grep -F '"env":"staging"' | grep -F '"status":"success"' | tail -1 || true)
[ -n "$STG" ] || { echo "release $REL has no successful staging deploy - refusing"; exit 1; }
if grep -F "\"release\":\"$REL\"" "$HIST" | grep -v '"env":"staging"' | grep -qF '"status":"success"'; then echo "release $REL is already live in production"; exit 1; fi
SHA=$(sed -n 's/.*"sha":"\([0-9a-fA-F]\{7,40\}\)".*/\1/p' <<<"$STG" | head -1)
[ -n "$SHA" ] || { echo "cannot read git sha for $REL"; exit 1; }
[ -s "$ARCHIVE" ] && [ -s "$SUMFILE" ] || { echo "tested tarball or its checksum is missing for $REL"; exit 1; }
( cd "$B/incoming" && sha256sum -c "$REL.sha256" >/dev/null 2>&1 ) || { echo "tarball does not match the checksum saved at staging time - refusing"; exit 1; }
echo "Promoting tested release $REL ($SHA) to production, requested by $BY"
exec bash "$HERE/deploy.sh" "$REL" "$SHA" "$BY"
