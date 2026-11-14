"""resources.py - the adaptive resource engine. Detects RAM / CPU / disk (cgroup-aware), calculates safe settings, detects upgrades/downgrades,
applies the MongoDB cache change at RUNTIME (no restart) and records every decision. Nothing here is hard-coded to 2 GB or 4 GB."""
import os, re, json
from . import common as C

MB = 1048576


def _meminfo():
    m = {}
    try:
        for l in open("/proc/meminfo"):
            k, v = l.split(":", 1)
            m[k] = int(v.split()[0]) // 1024
    except Exception:
        pass
    return m


def _cgroup_limit_mb():
    for p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            v = open(p).read().strip()
            if v.isdigit() and int(v) < 1 << 50:
                return int(v) // MB
        except Exception:
            pass
    return None


def _cpus():
    n = os.cpu_count() or 1
    try:
        q, p = open("/sys/fs/cgroup/cpu.max").read().split()
        if q != "max":
            n = max(1, min(n, round(int(q) / int(p))))
    except Exception:
        pass
    return n


def detect():
    mi = _meminfo()
    ram = mi.get("MemTotal", 0)
    lim = _cgroup_limit_mb()
    if lim:
        ram = min(ram, lim)
    load = os.getloadavg()
    d = {"ramMb": ram, "ramAvailMb": mi.get("MemAvailable", 0), "swapUsedMb": mi.get("SwapTotal", 0) - mi.get("SwapFree", 0), "cpus": _cpus(),
         "load": [round(x, 2) for x in load], "ts": C.iso()}
    dd = C.disk(C.DATA_DIR) or C.disk("/")
    d["diskTotalGb"] = dd["totalGb"] if dd else 0
    d["diskFreeGb"] = dd["freeGb"] if dd else 0
    return d


def calculate(d):
    """Safe allocation targets from what is ACTUALLY there. Reserve for Ubuntu/nginx/pm2 first, then the Node processes (blue, green, worker, staging),
    then give MongoDB a share of the rest. Filesystem cache is not double-counted: WiredTiger keeps its own cache and uses the page cache for the rest."""
    ram, cpus = d["ramMb"], d["cpus"]
    os_reserve = max(450, int(ram * 0.15))
    app_reserve = max(700, int(ram * 0.30))
    left = max(0, ram - os_reserve - app_reserve)
    frac = 0.70 if ram <= 3072 else 0.55
    cache_mb = int(left * frac)
    cache_mb = max(256, min(cache_mb, int((ram - 1024) * 0.5) if ram > 1536 else 256))      # never above MongoDB's own default ceiling; floor 256 MB
    cache_mb = cache_mb // 16 * 16
    api_heap = max(192, min(1536, int(app_reserve * 0.35)))
    big = ram >= 3584 and cpus >= 2
    prof = {
        "ramMb": ram, "cpus": cpus, "osReserveMb": os_reserve, "appReserveMb": app_reserve,
        "mongoCacheMb": cache_mb, "mongoCacheGb": round(cache_mb / 1024, 3),
        "nodeApiHeapMb": api_heap, "nodeWorkerHeapMb": api_heap, "pm2MaxMemoryRestartMb": int(api_heap * 1.4),
        "workerConcurrency": 1 if cpus == 1 else max(1, min(cpus, 4)),
        "backup": {"zstdLevel": 5 if big else 3, "zstdThreads": min(cpus, 2) if big else 1, "dumpParallelCollections": 4 if big else (2 if cpus > 1 else 1),
                   "rcloneTransfers": 2 if big else 1, "uploadConcurrency": 4 if big else (2 if ram >= 3072 else 1), "chunkMb": 32 if big else (16 if ram >= 3072 else 8), "nice": 19},
        "monitoring": {"heavyCheckEverySec": 120 if big else 300},
        "profile": "large" if ram >= 7168 else "medium" if big else "small",
    }
    return prof


def mode(d, storage_pct=0):
    """protective = reduce non-essential work (never touches the database itself)."""
    why = []
    if d["ramMb"] and d["ramAvailMb"] < d["ramMb"] * 0.10:
        why.append("less than 10% RAM available")
    if d["load"][1] > d["cpus"] * 2:
        why.append("sustained high CPU load")
    if storage_pct >= 90:
        why.append("disk above 90%")
    return ("protective" if why else "normal", why)


def _conf_cache_gb():
    try:
        m = re.search(r"cacheSizeGB:\s*([0-9.]+)", open(C.MONGOD_CONF).read())
        return float(m.group(1)) if m else None
    except Exception:
        return None


def _set_conf_cache(gb):
    s = open(C.MONGOD_CONF).read()
    if re.search(r"cacheSizeGB:\s*[0-9.]+", s):
        s = re.sub(r"cacheSizeGB:\s*[0-9.]+", "cacheSizeGB: %s" % gb, s)
    else:
        s = s.replace("engineConfig:", "engineConfig:\n      cacheSizeGB: %s" % gb, 1)
    tmp = C.MONGOD_CONF + ".sixstar.tmp"
    open(tmp, "w").write(s)
    os.replace(tmp, C.MONGOD_CONF)


def check(apply=True, force=False):
    """Detect -> compare with the last recorded state -> (if changed) plan, validate, apply, log, and flag for notification."""
    cur = detect()
    stored = C.read_json(os.path.join(C.STATE, "resources.json"), {})
    prev = (stored or {}).get("detected")
    prof = calculate(cur)
    storage_pct = (C.disk(C.DATA_DIR) or {}).get("usedPct", 0)
    md, why = mode(cur, storage_pct)
    rnd = lambda x: int(round(x / 256.0) * 256)                                  # a "2 GB" VPS reports ~1.9 GB: compare in 256 MB steps
    changed = force or not prev or rnd(prev.get("ramMb", 0)) != rnd(cur["ramMb"]) or prev.get("cpus") != cur["cpus"] or abs(prev.get("diskTotalGb", 0) - cur["diskTotalGb"]) > 2
    plan = {"ts": C.iso(), "previous": prev, "detected": cur, "calculated": prof, "applied": [], "restartRequired": False, "result": "unchanged"}
    if changed:
        kind = "initial" if not prev else ("upgrade" if rnd(cur["ramMb"]) > rnd(prev.get("ramMb", 0)) or cur["cpus"] > prev.get("cpus", 0) else "downgrade" if rnd(cur["ramMb"]) < rnd(prev.get("ramMb", 0)) else "change")
        plan["kind"] = kind
        if apply:
            cfg = _conf_cache_gb()
            want = prof["mongoCacheGb"]
            if cfg is None or abs(cfg - want) / max(want, 0.1) > 0.10:
                try:
                    if os.path.exists(C.MONGOD_CONF):
                        _set_conf_cache(want)
                        plan["applied"].append("mongod.conf cacheSizeGB %s -> %s" % (cfg, want))
                    env = C.load_env()
                    if env.get("MONGO_OPS_URI"):
                        C.mongosh('db.adminCommand({setParameter:1, wiredTigerEngineRuntimeConfig:"cache_size=%dM"}); return true;' % prof["mongoCacheMb"], timeout=30)
                        plan["applied"].append("runtime WiredTiger cache_size=%dM (no restart)" % prof["mongoCacheMb"])
                except Exception as e:
                    plan["restartRequired"] = True
                    plan["applied"].append("runtime change failed (%s): the new cache size applies at the next planned MongoDB restart" % str(e)[:120])
            env_path = os.path.join(C.BASE, "shared/resources.env")
            try:
                os.makedirs(os.path.dirname(env_path), exist_ok=True)
                open(env_path, "w").write("# generated by sixstar-mongoctl resources - read by deploy/PM2 settings, never edit by hand\nNODE_API_HEAP_MB=%d\nNODE_WORKER_HEAP_MB=%d\nPM2_MAX_MEMORY_RESTART_MB=%d\nWORKER_CONCURRENCY=%d\n" % (prof["nodeApiHeapMb"], prof["nodeWorkerHeapMb"], prof["pm2MaxMemoryRestartMb"], prof["workerConcurrency"]))
                plan["applied"].append("shared/resources.env (Node heap / PM2 limits)")
            except Exception as e:
                plan["applied"].append("could not write resources.env: %s" % e)
            plan["result"] = "applied"
        else:
            plan["result"] = "planned"
        C.append_jsonl(os.path.join(C.STATE, "resources-log.jsonl"), plan)
        if prev:
            C.event("resource_change", "info", "VPS resources %s detected: RAM %s -> %s MB, CPUs %s -> %s. MongoDB cache target %s MB (%s)." % (plan["kind"], prev.get("ramMb"), cur["ramMb"], prev.get("cpus"), cur["cpus"], prof["mongoCacheMb"], plan["result"]), notify=True)
    out = {"detected": cur, "profile": prof, "mode": md, "modeReasons": why, "restartPending": plan["restartRequired"] or (stored or {}).get("restartPending", False) and not changed,
           "lastChange": plan if changed else (stored or {}).get("lastChange"), "updatedAt": C.iso()}
    if md == "protective":
        out["protective"] = {"backup": {"zstdLevel": 1, "zstdThreads": 1, "rcloneTransfers": 1, "uploadConcurrency": 1, "dumpParallelCollections": 1}, "defer": ["retention", "deep-verify", "restore-tests"]}
    out["detected"] = cur
    C.write_json(os.path.join(C.STATE, "resources.json"), {**out, "detected": cur})
    return out


def effective_backup_profile():
    r = C.read_json(os.path.join(C.STATE, "resources.json"), None)
    if not r:
        r = check(apply=False)
    b = dict(r["profile"]["backup"])
    if r.get("mode") == "protective":
        b.update(r["protective"]["backup"])
    return b, r.get("mode", "normal")
