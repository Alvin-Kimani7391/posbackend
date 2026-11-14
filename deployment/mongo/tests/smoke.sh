#!/usr/bin/env bash
# Smoke test with fake mongodump/mongosh and a local "R2": proves encrypt -> upload -> verify -> recovery-point logic. Needs age, zstd, rclone, python3. Safe: touches only a temp dir.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/etc" "$T/var" "$T/state" "$T/stg" "$T/r2"
cat > "$T/bin/mongodump" <<'X'
#!/usr/bin/env bash
head -c 3000000 /dev/urandom | base64
X
cat > "$T/bin/mongosh" <<'X'
#!/usr/bin/env bash
if [[ "$*" == *"oplog.rs"* ]]; then echo '{"last":{"t":2000,"i":1},"first":{"t":1000,"i":1},"counts":{"db.sales":10,"db.products":5},"total":15,"dataMb":1}'; else echo '{"ok":1}'; fi
X
chmod +x "$T/bin/"*
age-keygen -o "$T/etc/id.txt" 2>/dev/null; age-keygen -y "$T/etc/id.txt" > "$T/etc/rec.txt"
echo 'MONGO_OPS_URI=mongodb://u:p@127.0.0.1/admin' > "$T/etc/ops.env"
export PATH="$T/bin:$PATH" SIXSTAR_BASE="$T" SIXSTAR_STATE="$T/state" SIXSTAR_ETC="$T/etc" SIXSTAR_VAR="$T/var" SIXSTAR_STAGING="$T/stg" SIXSTAR_OPS_ENV="$T/etc/ops.env" \
  SIXSTAR_RCLONE_BASE=":local:$T/r2" SIXSTAR_AGE_RECIPIENTS="$T/etc/rec.txt" SIXSTAR_AGE_IDENTITY="$T/etc/id.txt" SIXSTAR_LOAD_WAIT=0 SIXSTAR_RETRY_SLEEP=0 SIXSTAR_ALLOW_NONROOT=1
PYTHONPATH="$HERE/lib" python3 -I - <<'PY'
import sys, os; sys.path.insert(0, os.environ["PYTHONPATH"])
from sixstar_mongo import backup as B, common as C
os.makedirs(C.VAR, exist_ok=True)
r = B.full(manual=True); print("full:", r["status"]); assert r["status"] == "ok", r
st = B.S(); f = st["fulls"][-1]; assert f.get("verifiedAt"), "deep verify did not run"
assert B.verify("latest")["status"] == "ok"
# corrupt the object in 'R2' -> verification must FAIL
import glob; p = glob.glob(os.environ["SIXSTAR_RCLONE_BASE"].split(":local:")[1] + "/full/*.age")[0]
open(p, "r+b").write(b"corrupt!"); assert B.verify("latest")["status"] == "failed"; print("corruption detected: ok")
ks = B.keep_set([{"id": "2026%02d%02dT023000Z" % (m, d)} for m in (9, 10, 11) for d in range(1, 29)], {"daily": 30, "weekly": 8, "monthly": 12, "keepMinFull": 3}); assert len(ks) < 84 and "20261128T023000Z" in ks
print("retention keep_set ok:", len(ks), "of 84")
PY
echo SMOKE-OK
