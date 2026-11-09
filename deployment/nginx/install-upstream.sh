#!/usr/bin/env bash
# install-upstream.sh [apply|status|restore <backup_dir>]      run with:  sudo bash install-upstream.sh apply
# Makes the EXISTING site use the shared upstream while still pointing at 127.0.0.1:5000 (no traffic change).
# Only the proxy_pass line(s) that point at 127.0.0.1:5000 / localhost:5000 are edited. Everything else
# (server_name, listen 443 ssl, Certbot paths, redirects, proxy headers, WebSocket upgrade) is left byte-for-byte.
set -Eeuo pipefail
SITE=${SIXSTAR_SITE:-/etc/nginx/sites-available/sixstar-pos}
OWNER=${SUDO_USER:-sixstar}
B=/var/www/sixstar-pos
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UP=/etc/nginx/sixstar-active-upstream.conf
INC=/etc/nginx/conf.d/sixstar-upstream.conf
DOMAIN=${SIXSTAR_DOMAIN:-pos-api.sixstarsuppliers.com}
say() { echo "[$(date +%T)] $*"; }
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
cmd=${1:-status}

verify_site() { curl -fsS -m 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" >/dev/null 2>&1; }
reload_safe() { nginx -t >/dev/null 2>&1 && systemctl reload nginx; }

restore_from() { # restore_from <dir>
  local d=$1
  [ -f "$d/site.conf" ] || { echo "no backup at $d"; return 1; }
  cp -p "$d/site.conf" "$SITE"
  if [ -f "$d/upstream.existed" ]; then cp -p "$d/upstream.conf" "$UP"; else rm -f "$UP"; fi
  if [ -f "$d/inc.existed" ]; then cp -p "$d/inc.conf" "$INC"; else rm -f "$INC"; fi
  nginx -t && systemctl reload nginx
}

case "$cmd" in
status)
  echo "site:     $SITE ($( [ -f "$SITE" ] && echo found || echo MISSING ))"
  echo "upstream: $( [ -f "$UP" ] && cat "$UP" | tr '\n' ' ' || echo not installed )"
  echo "include:  $( [ -f "$INC" ] && echo installed || echo not installed )"
  echo "proxy_pass lines:"; grep -n 'proxy_pass' "$SITE" || true ;;

restore) restore_from "${2:?usage: restore <backup_dir>}" && say "restored from $2" ;;

apply)
  # ---- validate everything first; change nothing yet ----
  [ -f "$SITE" ] || { echo "site file not found: $SITE (set SIXSTAR_SITE=...)"; exit 1; }
  command -v nginx >/dev/null && command -v curl >/dev/null || { echo "nginx/curl missing"; exit 1; }
  nginx -t >/dev/null 2>&1 || { echo "nginx -t already FAILS before any change. Fix that first."; nginx -t; exit 1; }
  grep -qE 'include[[:space:]]+/etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf || { echo "nginx.conf does not include conf.d/*.conf - install the include manually inside http{}"; exit 1; }
  if grep -q 'sixstar_active' "$SITE"; then echo "already installed (site already uses sixstar_active). Nothing to do."; exit 0; fi
  nginx -T 2>/dev/null | grep -q 'upstream[[:space:]]\+sixstar_active' && { echo "an upstream named sixstar_active already exists elsewhere"; exit 1; }
  n=$(grep -cE 'proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):5000' "$SITE" || true)
  [ "$n" -ge 1 ] || { echo "no proxy_pass to :5000 found in $SITE - refusing to guess"; exit 1; }
  others=$(grep -E 'proxy_pass' "$SITE" | grep -vE 'http://(127\.0\.0\.1|localhost):5000' || true)
  [ -z "$others" ] || { echo "NOTE: these other proxy_pass lines will be left unchanged:"; echo "$others"; }
  verify_site || { echo "https://$DOMAIN/health does not answer BEFORE the change - refusing to proceed"; exit 1; }

  # ---- backup (outside /etc) ----
  BK="$B/backups/nginx/install-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"
  cp -p "$SITE" "$BK/site.conf"
  [ -f "$UP" ] && { cp -p "$UP" "$BK/upstream.conf"; touch "$BK/upstream.existed"; }
  [ -f "$INC" ] && { cp -p "$INC" "$BK/inc.conf"; touch "$BK/inc.existed"; }
  say "backup saved: $BK"

  # ---- apply ----
  install -o "$OWNER" -g "$OWNER" -m 644 "$HERE/sixstar-active-upstream.conf" "$UP"
  install -o root -g root -m 644 "$HERE/conf.d-sixstar-upstream.conf" "$INC"
  sed -E -i 's#proxy_pass([[:space:]]+)http://(127\.0\.0\.1|localhost):5000([^;]*);#proxy_pass\1http://sixstar_active\3;#' "$SITE"

  if ! nginx -t >/dev/null 2>&1; then say "nginx -t FAILED - restoring"; nginx -t || true; restore_from "$BK"; exit 1; fi
  say "nginx -t passed. Changes to the site file:"; diff -u "$BK/site.conf" "$SITE" || true
  # nothing except proxy_pass lines may differ
  if diff "$BK/site.conf" "$SITE" | grep -E '^[<>]' | grep -vqE 'proxy_pass'; then say "UNEXPECTED change outside proxy_pass - restoring"; restore_from "$BK"; exit 1; fi
  systemctl reload nginx
  sleep 2
  if verify_site; then say "OK: https://$DOMAIN/health answers through the shared upstream (still port 5000)."; say "To undo:  sudo bash $HERE/install-upstream.sh restore $BK"
  else say "health check FAILED after reload - restoring"; restore_from "$BK"; verify_site && say "restored; site answers again" || say "RESTORED CONFIG BUT SITE NOT ANSWERING - check immediately"; exit 1; fi ;;
*) echo "usage: install-upstream.sh [apply|status|restore <dir>]"; exit 2 ;;
esac