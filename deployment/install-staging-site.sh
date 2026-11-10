#!/usr/bin/env bash
# sudo bash install-staging-site.sh        Adds the staging API site. Production's site file is NOT modified.
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NAME=sixstar-staging; AV=/etc/nginx/sites-available/$NAME; EN=/etc/nginx/sites-enabled/$NAME
HOSTN=staging-api.sixstarsuppliers.com
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
nginx -t >/dev/null 2>&1 || { echo "nginx -t already fails - fix that first"; nginx -t; exit 1; }
[ ! -e "$AV" ] && [ ! -e "$EN" ] || { echo "$NAME already exists - nothing to do"; exit 0; }
curl -fsS -m 5 http://127.0.0.1:5200/health >/dev/null || { echo "staging API is not answering on :5200 - deploy staging first"; exit 1; }
getent hosts "$HOSTN" >/dev/null || echo "WARNING: $HOSTN does not resolve yet (add the Cloudflare DNS record; certbot will fail until it does)"
install -m 644 "$HERE/staging-api.conf" "$AV"; ln -s "$AV" "$EN"
if nginx -t >/dev/null 2>&1; then systemctl reload nginx; echo "OK: staging site installed (HTTP)."
else echo "nginx -t FAILED - removing the new site"; nginx -t || true; rm -f "$EN" "$AV"; exit 1; fi
echo "Next:  sudo certbot --nginx -d $HOSTN --redirect"
