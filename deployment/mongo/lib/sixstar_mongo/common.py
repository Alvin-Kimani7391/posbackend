"""common.py - shared helpers. Python 3 standard library only. Everything path-related can be overridden by env vars (used by the tests)."""
import fcntl, json, os, re, subprocess, sys, time
from datetime import datetime, timezone

BASE = os.environ.get("SIXSTAR_BASE", "/var/www/sixstar-pos")
STATE = os.environ.get("SIXSTAR_STATE", os.path.join(BASE, "shared/db"))          # read by the dashboard (group-readable)
ETC = os.environ.get("SIXSTAR_ETC", "/etc/sixstar")                                # secrets + config (root only)
VAR = os.environ.get("SIXSTAR_VAR", "/var/lib/sixstar-mongo")                      # private working state
STAGING = os.environ.get("SIXSTAR_STAGING", "/var/backups/sixstar/staging")
MONGOD_CONF = os.environ.get("MONGOD_CONF", "/etc/mongod.conf")
DATA_DIR = os.environ.get("MONGO_DATA_DIR", "/var/lib/mongodb")
LOG_FILE = os.environ.get("MONGOD_LOG", "/var/log/mongodb/mongod.log")
ENV_FILE = os.environ.get("SIXSTAR_OPS_ENV", os.path.join(ETC, "mongo-ops.env"))
CONF_FILE = os.environ.get("SIXSTAR_BACKUP_CONF", os.path.join(ETC, "backup.json"))
SYSTEMCTL = os.environ.get("SIXSTAR_SYSTEMCTL", "systemctl")

DEFAULT_CONF = {
    "retention": {"daily": 30, "weekly": 8, "monthly": 12, "keepMinFull": 3, "oplogDays": 7},
    "oplogIntervalMin": 15,
    "fullBackupMaxAgeHours": 36,
    "verifyDeepAfterBackup": True,
    "restoreTestMaxAgeDays": 10,
    "bucket": "sixstar-pos-backups",
}


def now():
    return time.time()


def iso(ts=None):
    return datetime.fromtimestamp(ts if ts is not None else now(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def load_env(path=None):
    out = {}
    try:
        with open(path or ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


def conf():
    c = json.loads(json.dumps(DEFAULT_CONF))
    try:
        with open(CONF_FILE) as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(c.get(k), dict):
                c[k].update(v)
            else:
                c[k] = v
    except Exception:
        pass
    return c


def read_json(path, fallback=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return fallback


def write_json(path, obj, mode=0o640):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def append_jsonl(path, obj, mode=0o640):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = not os.path.exists(path)
    with open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")
    if new:
        os.chmod(path, mode)


def read_jsonl(path, last=200):
    try:
        with open(path) as f:
            lines = f.read().splitlines()[-last:]
    except FileNotFoundError:
        return []
    out = []
    for l in lines:
        try:
            out.append(json.loads(l))
        except Exception:
            pass
    return out


def event(kind, severity, message, **extra):
    """Infrastructure event: shown in the dashboard history and (for notify=True) emailed by the guardian."""
    e = {"ts": iso(), "kind": kind, "severity": severity, "message": message[:400]}
    e.update(extra)
    append_jsonl(os.path.join(STATE, "history.jsonl"), e)
    return e


class Lock:
    """Non-blocking exclusive lock: a second job of the same name exits instead of piling up."""
    def __init__(self, name):
        os.makedirs(VAR, exist_ok=True)
        self.path = os.path.join(VAR, name + ".lock")
        self.f = None

    def acquire(self):
        self.f = open(self.path, "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.f.write(str(os.getpid()))
            self.f.flush()
            return True
        except OSError:
            return False

    def release(self):
        if self.f:
            try:
                fcntl.flock(self.f, fcntl.LOCK_UN)
            finally:
                self.f.close()
                self.f = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *a):
        self.release()


def run(cmd, timeout=30, env=None, input=None, check=False):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, input=input)
        if check and p.returncode != 0:
            raise RuntimeError("%s failed (%d): %s" % (cmd[0], p.returncode, (p.stderr or p.stdout)[:300]))
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "%s not installed" % cmd[0]
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"


def mongosh(script, uri=None, timeout=25):
    """Run JavaScript in mongosh and return the parsed JSON it prints. `script` must be an expression body that returns a value."""
    env = load_env()
    uri = uri or env.get("MONGO_OPS_URI", "")
    wrapped = "print(EJSON.stringify((function(){%s})(), {relaxed:true}))" % script
    rc, out, err = run(["mongosh", "--quiet", "--norc", uri, "--eval", wrapped], timeout)
    if rc != 0:
        raise RuntimeError(("mongosh: " + (err or out))[:300])
    last = [l for l in out.splitlines() if l.strip()][-1] if out else "null"
    return json.loads(last)


def redact(s):
    return re.sub(r"(mongodb(?:\+srv)?://[^:/@\s]+:)[^@\s]+@", r"\1***@", str(s))


def disk(path):
    try:
        st = os.statvfs(path)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        return {"path": path, "totalGb": round(total / 1073741824, 1), "usedGb": round((total - free) / 1073741824, 1), "freeGb": round(free / 1073741824, 2),
                "usedPct": round(100 * (total - free) / total, 1) if total else 0, "dev": os.stat(path).st_dev}
    except Exception:
        return None
