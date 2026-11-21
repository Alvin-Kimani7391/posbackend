"""guardian.py - monitoring, controlled auto-recovery and alerting. Runs every minute from cron as root, completely independent of Node, the dashboard and
(for alert e-mail) the database. READ-ONLY apart from the guarded watchdog restart of a mongod that is not running at all."""
import html, json, os, re, time, urllib.request, urllib.error
from datetime import datetime
from zoneinfo import ZoneInfo
from . import common as C
from . import resources as RES

SEV_RANK = {"critical": 3, "high": 2, "warning": 1, "info": 0}
REPEAT = {"critical": 6 * 3600, "high": 12 * 3600, "warning": 24 * 3600}


def _tail(path, nbytes=4 * 1048576):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            return f.read().decode("utf8", "replace").splitlines()
    except Exception:
        return None


def log_counts():
    lines = _tail(C.LOG_FILE)
    if lines is None:
        return {"available": False}
    cut = C.now() - 3600
    slow = failed = errors = 0
    for l in lines:
        if '"Slow query"' not in l and "Authentication failed" not in l and '"s":"E"' not in l and '"s":"F"' not in l:
            continue
        m = re.search(r'"\$date":"([^"]+)"', l)
        ts = C.parse_iso(m.group(1)) if m else None
        if ts is not None and ts < cut:
            continue
        if '"Slow query"' in l:
            slow += 1
        if "Authentication failed" in l:
            failed += 1
        if '"s":"E"' in l or '"s":"F"' in l:
            errors += 1
    return {"available": True, "slowQueries1h": slow, "failedAuth1h": failed, "errors1h": errors}


HEALTH_JS = r"""
var ss = db.adminCommand({serverStatus:1});
var t0 = Date.now(); db.adminCommand({ping:1}); var lat = Date.now() - t0;
var rs = null; try { rs = db.adminCommand({replSetGetStatus:1}); } catch (e) { rs = {error: String(e).slice(0,120)}; }
var oplog = null;
try { var o = db.getSiblingDB('local').oplog.rs; var f = o.find().sort({$natural:1}).limit(1).next().ts; var l = o.find().sort({$natural:-1}).limit(1).next().ts;
  oplog = {first: f.t, last: l.t, maxMb: Math.round(db.getSiblingDB('local').oplog.rs.stats().maxSize/1048576)}; } catch (e) {}
var wt = ss.wiredTiger ? ss.wiredTiger.cache : {};
return {version: ss.version, uptime: ss.uptime, conn: ss.connections, rss: ss.mem.resident,
  cache: {used: wt['bytes currently in the cache'], max: wt['maximum bytes configured'], dirty: wt['tracked dirty bytes in the cache']},
  lat: lat, oplog: oplog,
  rs: rs && rs.members ? {set: rs.set, myState: rs.myState, members: rs.members.map(function(m){return {name:m.name, state:m.stateStr, health:m.health};})} : (rs||null)};
"""
DBS_JS = r"""
return db.adminCommand({listDatabases:1}).databases.filter(function(d){return ['admin','local','config'].indexOf(d.name)<0;}).map(function(d){
  var s = db.getSiblingDB(d.name).stats(); return {name:d.name, sizeMb:Math.round(s.dataSize/1048576), storageMb:Math.round(s.storageSize/1048576), indexMb:Math.round(s.indexSize/1048576), collections:s.collections, objects:s.objects};});
"""


def public_exposure():
    rc, out, _ = C.run(["ss", "-ltnH"], 5)
    for l in out.splitlines():
        c = l.split()
        if len(c) >= 4 and c[3].endswith(":27017"):
            host = c[3].rsplit(":", 1)[0].strip("[]")
            if host not in ("127.0.0.1", "::1", "localhost"):
                return True
    return False


def auth_enforced():
    rc, out, err = C.run(["mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin", "--eval", "try{db.adminCommand({listDatabases:1}); print('OPEN')}catch(e){print('DENIED')}"], 15)
    return None if rc == 127 else ("OPEN" not in out)


def backend_state():
    slot = None
    try:
        slot = open(os.path.join(C.BASE, "deployment/state/active_slot")).read().strip()
    except Exception:
        pass
    port = {"blue": 5100, "green": 5101, "legacy": 5000}.get(slot)
    if not port:
        return {"slot": slot, "checked": False}
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health/%s" % (port, "" if port == 5000 else "ready"), timeout=2) as r:
            return {"slot": slot, "port": port, "checked": True, "ready": r.status == 200}
    except urllib.error.HTTPError as e:
        return {"slot": slot, "port": port, "checked": True, "ready": False, "code": e.code}
    except Exception:
        return {"slot": slot, "port": port, "checked": True, "ready": False}


def watchdog(active):
    """Controlled recovery: restart a mongod that is NOT running, at most 3 times per hour, then stop and escalate. Never restarts a healthy or merely slow database."""
    if os.path.exists(os.path.join(C.VAR, "maintenance.hold")):
        return {"action": "held"}
    st = C.read_json(os.path.join(C.VAR, "watchdog.json"), {"attempts": []})
    st["attempts"] = [t for t in st.get("attempts", []) if t > C.now() - 3600]
    if active:
        if st.get("attempts"):
            pass
        C.write_json(os.path.join(C.VAR, "watchdog.json"), st, 0o600)
        return {"action": "none"}
    if len(st["attempts"]) >= 3:
        return {"action": "gave_up", "attempts": len(st["attempts"])}
    st["attempts"].append(C.now())
    C.write_json(os.path.join(C.VAR, "watchdog.json"), st, 0o600)
    rc, out, err = C.run([C.SYSTEMCTL, "restart", "mongod"], 120)
    C.event("watchdog_restart", "high", "mongod was not running; restart attempt %d of 3 %s" % (len(st["attempts"]), "succeeded" if rc == 0 else "FAILED: " + err[:120]))
    return {"action": "restarted" if rc == 0 else "restart_failed", "attempts": len(st["attempts"])}


def collect():
    env = C.load_env()
    inst = C.run(["which", "mongod"], 5)[0] == 0
    st = {"guardianVersion": 1, "generatedAt": C.iso(), "alerts": []}
    al = st["alerts"]

    def alert(code, sev, msg, action=""):
        al.append({"id": code, "code": code, "severity": sev, "message": msg, "action": action})

    m = {"installed": inst, "running": False}
    st["mongo"] = m
    if not inst:
        alert("mongo_missing", "info", "MongoDB Community is not installed yet (migration phase 2). Atlas is still the live database.")
    else:
        active = C.run([C.SYSTEMCTL, "is-active", "mongod"], 10)[1] == "active"
        wd = watchdog(active)
        m["watchdog"] = wd
        if not active:
            alert("mongo_down", "critical", "MongoDB service is not running." + (" Automatic restarts did not recover it - manual action needed." if wd.get("action") == "gave_up" else ""), "Check: journalctl -u mongod -n 100; df -h; free -m")
        else:
            try:
                h = C.mongosh(HEALTH_JS)
                m.update({"running": True, "version": h["version"], "uptimeSec": h["uptime"], "latencyMs": h["lat"], "connections": {"current": h["conn"]["current"], "available": h["conn"]["available"]},
                          "rssMb": h["rss"], "cache": {"usedMb": round(h["cache"]["used"] / 1048576), "maxMb": round(h["cache"]["max"] / 1048576), "dirtyMb": round(h["cache"]["dirty"] / 1048576)}})
                rs = h.get("rs") or {}
                m["replSet"] = {"name": rs.get("set"), "state": (rs.get("members") or [{}])[0].get("state") if rs.get("members") else None, "members": rs.get("members"), "error": rs.get("error")}
                if h.get("oplog"):
                    win = (h["oplog"]["last"] - h["oplog"]["first"]) / 3600.0
                    m["oplog"] = {"windowHours": round(win, 1), "maxMb": h["oplog"]["maxMb"]}
                    if win < 1:
                        alert("oplog_window", "warning", "Oplog window is only %.1f hours; point-in-time recovery chains can break." % win, "Increase replication.oplogSizeMB in /etc/mongod.conf (planned restart).")
                if not rs.get("members"):
                    alert("replset_missing", "high", "MongoDB is not running as a replica set; multi-document transactions and oplog backups will not work.", "Run install-mongodb.sh --init-replset")
                elif any(x.get("health") != 1 for x in rs["members"]) or rs["members"][0].get("state") not in ("PRIMARY",) and len(rs["members"]) == 1:
                    alert("replset_unhealthy", "critical", "Replica set member state is %s." % rs["members"][0].get("state"), "rs.status() in mongosh; journalctl -u mongod")
                cp = 100 * m["cache"]["usedMb"] / max(1, m["cache"]["maxMb"])
                if cp > 95 and m["cache"]["dirtyMb"] > m["cache"]["maxMb"] * 0.2:
                    alert("cache_pressure", "warning", "WiredTiger cache is %d%% used with heavy dirty data - the database is memory-constrained." % cp, "Check slow queries / upgrade RAM.")
                tot = m["connections"]["current"] + m["connections"]["available"]
                if tot and 100.0 * m["connections"]["current"] / tot > 80:
                    alert("connections", "warning", "%d of %d connections in use." % (m["connections"]["current"], tot), "Check for connection leaks / lower maxPoolSize.")
                if m["latencyMs"] > 500:
                    alert("slow_ping", "warning", "MongoDB ping took %d ms." % m["latencyMs"], "Check CPU/disk load.")
            except Exception as e:
                m["running"] = False
                alert("mongo_connect", "critical", "MongoDB is running but the database connection failed: %s" % C.redact(str(e))[:160], "Check credentials in /etc/sixstar/mongo-ops.env and mongod.log.")
        # heavier checks on a slower cadence
        cache_p = os.path.join(C.VAR, "heavy.json")
        every = (RES.calculate(RES.detect())["monitoring"]["heavyCheckEverySec"])
        heavy = C.read_json(cache_p, {})
        if m.get("running") and (C.now() - heavy.get("at", 0) > every):
            try:
                heavy = {"at": C.now(), "dbs": C.mongosh(DBS_JS, timeout=40), "auth": auth_enforced(), "exposed": public_exposure()}
                C.write_json(cache_p, heavy, 0o600)
            except Exception:
                pass
        m["dbs"] = heavy.get("dbs", [])
        m["auth"] = {"enforced": heavy.get("auth")}
        m["publicExposure"] = heavy.get("exposed", False)
        if heavy.get("auth") is False:
            alert("auth_off", "critical", "MongoDB accepts unauthenticated commands. Authentication must be enabled.", "Set security.authorization: enabled in /etc/mongod.conf and restart in a maintenance window.")
        if heavy.get("exposed"):
            alert("mongo_public", "critical", "MongoDB port 27017 is listening on a public address. It must only listen on 127.0.0.1.", "Set net.bindIp: 127.0.0.1 and block 27017 in the firewall.")
        lc = log_counts()
        m.update({k: v for k, v in lc.items() if k != "available"})
        if lc.get("failedAuth1h", 0) >= 20:
            alert("failed_auth", "warning", "%d failed MongoDB logins in the last hour." % lc["failedAuth1h"], "Review mongod.log; make sure 27017 is closed to the internet.")
        if lc.get("slowQueries1h", 0) >= 50:
            alert("slow_queries", "warning", "%d slow queries in the last hour." % lc["slowQueries1h"], "Review indexes for the slowest operations in mongod.log.")

    # server + storage (always)
    det = RES.detect()
    st["server"] = {"ramMb": det["ramMb"], "ramAvailMb": det["ramAvailMb"], "swapUsedMb": det["swapUsedMb"], "cpus": det["cpus"], "load": det["load"]}
    try:
        st["server"]["uptimeSec"] = int(float(open("/proc/uptime").read().split()[0]))
    except Exception:
        pass
    disks, seen, worst = {}, set(), 0
    for label, p in (("Database disk", C.DATA_DIR), ("Backup staging", C.STAGING), ("Logs", os.path.dirname(C.LOG_FILE)), ("System disk", "/")):
        d = C.disk(p)
        if d and d["dev"] not in seen:
            seen.add(d["dev"])
            d.pop("dev")
            disks[label] = d
            worst = max(worst, d["usedPct"])
    st["storage"] = {"disks": disks, "worstPct": worst}
    if worst >= 95: alert("disk", "critical", "Disk is %d%% full (EMERGENCY, 95%%). Protective actions are active." % worst, "Free space now; do NOT delete MongoDB data files.")
    elif worst >= 90: alert("disk", "critical", "Disk is %d%% full (critical, 90%%)." % worst, "Clean logs/old staging files; plan a disk upgrade.")
    elif worst >= 80: alert("disk", "high", "Disk is %d%% full (80%% threshold)." % worst, "Plan cleanup or an upgrade.")
    elif worst >= 70: alert("disk", "warning", "Disk is %d%% full (70%% threshold)." % worst)
    if det["ramMb"] and det["ramAvailMb"] < det["ramMb"] * 0.08 or (det["ramMb"] and det["swapUsedMb"] > det["ramMb"] * 0.25):
        alert("ram_risk", "critical", "RAM exhaustion risk: %d MB available, %d MB swap in use." % (det["ramAvailMb"], det["swapUsedMb"]), "Check pm2 processes (pm2 list) and MongoDB cache; consider a RAM upgrade.")

    # resources
    try:
        r = RES.check(apply=True)
        st["resources"] = {"profile": r["profile"], "mode": r["mode"], "modeReasons": r.get("modeReasons", []), "restartPending": r.get("restartPending", False), "lastChange": r.get("lastChange"), "detected": r["detected"]}
        if r["mode"] == "protective":
            alert("protective_mode", "warning", "Protective mode: %s. Non-essential jobs are deferred and backups are throttled." % ", ".join(r.get("modeReasons", [])))
    except Exception as e:
        st["resources"] = {"error": str(e)[:150]}

    # backups / recovery
    try:
        from . import backup as BK
        st["backup"], balerts = BK.view()
        for a in balerts:
            alert(*a)
    except Exception as e:
        st["backup"] = {"configured": False, "error": str(e)[:150]}

    # backend (only meaningful when MongoDB itself is fine, so a DB outage is not reported twice)
    st["backend"] = backend_state()
    if m.get("running") and st["backend"].get("checked") and not st["backend"].get("ready"):
        alert("backend_down", "high", "The %s API slot is not ready although MongoDB is healthy." % st["backend"].get("slot"), "pm2 list; pm2 logs sixstar-%s --lines 80" % st["backend"].get("slot"))

    st["schedule"] = {"full": "daily 02:30", "oplog": "every %d min" % C.conf()["oplogIntervalMin"], "verify": "after every backup", "restoreTest": "Wednesday 03:30", "pitrTest": "Saturday 03:30", "retention": "daily 05:00", "tz": "Africa/Nairobi"}
    prev = {a["id"]: a.get("since") for a in (C.read_json(os.path.join(C.STATE, "status.json"), {}) or {}).get("alerts", [])}
    for a in al:
        a["since"] = prev.get(a["id"]) or C.iso()
    al.sort(key=lambda a: -SEV_RANK[a["severity"]])
    st["health"] = "critical" if any(a["severity"] in ("critical",) for a in al) else "warning" if any(a["severity"] in ("high", "warning") for a in al) else "ok"
    return st


# ---------------- e-mail (independent of Node and of the database) ----------------
def recipients():
    env = C.load_env()
    out = [e.strip() for e in env.get("ALERT_EMAILS", "").split(",") if e.strip()]
    out += (C.read_json(os.path.join(C.STATE, "alert-recipients.json"), {}) or {}).get("emails", [])
    seen, res = set(), []
    for e in out:
        if e.lower() not in seen:
            seen.add(e.lower())
            res.append(e)
    return res


def send_mail(subject, html_body, text_body=None):
    env = C.load_env()
    to = recipients()
    if not to or not env.get("BREVO_API_KEY") or not env.get("BREVO_SENDER_EMAIL"):
        return False
    payload = {
        "sender": {"email": env["BREVO_SENDER_EMAIL"], "name": env.get("BREVO_SENDER_NAME", "Six Star POS")},
        "to": [{"email": e} for e in to],
        "subject": subject,
        "htmlContent": html_body,
    }
    if text_body:
        payload["textContent"] = text_body
    body = json.dumps(payload).encode()
    req = urllib.request.Request(env.get("BREVO_URL", "https://api.brevo.com/v3/smtp/email"), data=body, headers={"api-key": env["BREVO_API_KEY"], "content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


esc = lambda s: html.escape(str(s), quote=True)


def _local_time(value):
    if not value:
        return "Not recorded"
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt.astimezone(ZoneInfo("Africa/Nairobi")).strftime("%d %b %Y, %I:%M:%S %p EAT")
    except Exception:
        return str(value)


def _event_report(host, event):
    kind = event.get("kind", "")
    title = {
        "backup_ok": "Full database backup completed",
        "pitr_test_passed": "Point-in-time recovery test passed",
        "restore_test_passed": "Full restore test passed",
        "backup_failed": "Full database backup failed",
        "oplog_failed": "PITR oplog archiving failed",
        "pitr_test_failed": "Point-in-time recovery test failed",
        "restore_test_failed": "Full restore test failed",
        "verify_failed": "Backup verification failed",
        "oplog_gap": "PITR recovery chain has a gap",
    }.get(kind, event.get("kind", "Infrastructure event").replace("_", " ").title())

    guidance = {
        "backup_failed": (
            "The latest full backup did not complete. Your newest recoverable backup may be older than expected.",
            "Inspect the backup error and guardian logs. Check MongoDB connectivity, disk space, permissions and the backup destination. Correct the cause before retrying with: sudo sixstar-mongoctl backup full. Preserve existing backups."
        ),
        "r2_upload_failed": (
            "The remote backup copy was not confirmed. Off-server protection may be incomplete.",
            "Check network connectivity and R2 configuration without displaying credentials. Inspect the upload status and retry process. Preserve the staged local copy until a remote copy is verified."
        ),
        "oplog_failed": (
            "PITR archive coverage may stop advancing. Recovery to newer points in time may be unavailable.",
            "Inspect the oplog archiving error, latest archived position, available disk space and remote upload status. Confirm chain continuity before relying on PITR. Do not delete oplog segments or restart MongoDB as a first response."
        ),
        "oplog_gap": (
            "The current PITR chain has a gap. Point-in-time recovery across the missing interval may be unavailable.",
            "Preserve all existing full backups and oplog segments. Review the gap timestamp and chain status. Confirm a new full backup and a healthy contiguous chain before relying on newer PITR coverage."
        ),
        "verify_failed": (
            "The affected backup did not pass its integrity verification and should not be treated as a confirmed recovery point.",
            "Preserve the backup and its metadata. Review the verification error and logs, then verify another known-good backup. Create and verify a fresh full backup if necessary. Do not delete the failed copy during investigation."
        ),
        "pitr_test_failed": (
            "The latest PITR recovery test failed. Point-in-time recoverability has not been demonstrated.",
            "Inspect the PITR test details and restore-test logs. Check the selected backup, oplog chain continuity and available scratch disk space. Test another verified recovery point if needed. Never restore over the live production database during diagnosis."
        ),
        "restore_test_failed": (
            "The latest full restore test failed. Successful recovery from that tested backup has not been demonstrated.",
            "Inspect the restore-test error and logs. Check backup integrity, encryption access, disk space and MongoDB restore output. Preserve the source backup and test an alternative verified backup in isolation, never over production."
        ),
        "retention_failed": (
            "Backup retention cleanup did not complete. Storage usage may grow beyond its expected level.",
            "Inspect the retention error and disk/storage usage. Check permissions and remote storage connectivity. Retry retention only after understanding the failure. Do not manually delete backup or oplog files."
        )
    }

    rows = []
    text_rows = []
    def add(label, value):
        value = str(value if value not in (None, "") else "Not recorded")
        rows.append("<tr><td style='padding:8px;border-bottom:1px solid #e8edf2;color:#64748b;width:38%%;vertical-align:top;word-break:break-word;overflow-wrap:anywhere'>%s</td><td style='padding:8px;border-bottom:1px solid #e8edf2;color:#0b1f33;font-weight:600;vertical-align:top;word-break:break-all;overflow-wrap:anywhere'>%s</td></tr>" % (esc(label), esc(value)))
        text_rows.append("%s: %s" % (label, value))

    add("Event time", _local_time(event.get("ts")))
    add("Server", host)

    if kind == "backup_ok":
        try:
            from . import backup as B
            st = B.S()
            manifest = next((f for f in st.get("fulls", []) if f.get("id") == event.get("id")), None)
            if manifest:
                add("Backup ID", manifest.get("id"))
                add("Started", _local_time(manifest.get("startedAt")))
                add("Completed", _local_time(manifest.get("finishedAt")))
                add("Duration", "%s seconds" % manifest.get("durationSec", "Not recorded"))
                add("Encrypted size", "%.2f MB" % (manifest.get("sizeBytes", 0) / 1048576))
                add("Original data size", "%.2f MB" % (manifest.get("rawBytes", 0) / 1048576))
                add("Documents", manifest.get("totalDocs"))
                add("Collections", len(manifest.get("counts") or {}))
                add("Compression / encryption", "%s / %s" % (manifest.get("compression"), manifest.get("encryption")))
                add("SHA-256", manifest.get("sha256"))
                add("Remote upload", "Confirmed" if manifest.get("uploaded") else "Not confirmed")
                add("Deep verification", "Passed at " + _local_time(manifest.get("verifiedAt")) if manifest.get("verifiedAt") else "Pending")
                add("PITR chain", manifest.get("chain"))
                chain = st.get("chain") or {}
                if chain.get("id") == manifest.get("chain"):
                    add("PITR chain continuity", "Contiguous" if chain.get("contiguous") else "Not confirmed")
                    add("PITR covered until", _local_time(chain.get("coveredUntil")))
            else:
                add("Backup details", "Manifest not found in local backup state")
        except Exception:
            add("Backup details", "Could not load backup manifest; inspect the infrastructure dashboard")
    elif kind in ("pitr_test_passed", "pitr_test_failed", "restore_test_passed", "restore_test_failed"):
        test_kind = "pitr" if kind.startswith("pitr_") else "restore"
        saved = C.read_json(os.path.join(C.STATE, "restore-tests.json"), {}) or {}
        result = saved.get(test_kind) or {}
        add("Test result", result.get("status", kind.rsplit("_", 1)[-1]))
        add("Backup ID tested", result.get("backupId"))
        add("Details", result.get("detail") or event.get("message"))
        add("Documents restored", result.get("documents"))
        add("Duration", ("%s seconds" % result.get("durationSec")) if result.get("durationSec") is not None else None)
        if test_kind == "pitr":
            import re
            match = re.search(r"(\d+) oplog segment", result.get("detail", ""))
            add("Oplog segments replayed", match.group(1) if match else None)
    else:
        add("Severity", event.get("severity", "Not recorded").upper())
        add("Details", event.get("message", "No event details recorded"))
        add("Recommended action", "Open Admin > Infrastructure > Database and review the reported event. Preserve backup data while investigating; do not perform destructive recovery actions.")

    if kind in guidance:
        impact, action = guidance[kind]
        add("Operational impact", impact)
        add("Recommended action", action)

    color = "#dc2626" if event.get("severity") in ("critical", "high") or kind.endswith("_failed") or kind == "oplog_gap" else "#0f766e"
    html_body = (
        "<div style='background:#f3f6fa;padding:12px;width:100%%;box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;color:#0b1f33'>"
        "<div style='max-width:640px;width:100%%;margin:0 auto;box-sizing:border-box;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden'>"
        "<div style='background:#0b1f33;padding:18px 20px;color:#ffffff'><div style='font-size:12px;letter-spacing:1px;color:#99f6e4'>SIX STAR POS · DATABASE OPERATIONS</div>"
        "<h2 style='margin:10px 0 0;font-size:21px'>%s</h2></div>"
        "<div style='padding:18px 20px'><div style='display:inline-block;background:%s;color:#ffffff;padding:6px 11px;border-radius:20px;font-size:12px;font-weight:bold'>%s</div>"
        "<table role='presentation' style='width:100%%;table-layout:fixed;border-collapse:collapse;margin-top:16px'>%s</table>"
        "<p style='margin:20px 0 0;color:#64748b;font-size:12px'>Automated infrastructure report. Credentials and secret keys are never included.</p>"
        "</div></div></div>"
    ) % (esc(title), color, esc(event.get("severity", "INFO").upper()), "".join(rows))
    text_body = "SIX STAR POS - DATABASE OPERATIONS\n%s\n%s\n\n%s" % (title, event.get("severity", "info").upper(), "\n".join(text_rows))
    return title, html_body, text_body


def notify(status):
    sp = os.path.join(C.VAR, "alert-state.json")
    state = C.read_json(sp, {"alerts": {}, "events": 0}) or {"alerts": {}}
    nowt = C.now()
    due, nxt = [], {}
    for a in status["alerts"]:
        if a["severity"] == "info":
            continue
        prev = state["alerts"].get(a["code"])
        if not prev or nowt - prev["lastSent"] >= REPEAT[a["severity"]]:
            due.append(a)
            nxt[a["code"]] = {"severity": a["severity"], "lastSent": nowt}
        else:
            nxt[a["code"]] = prev
    had_crit = any(v["severity"] in ("critical", "high") for v in state["alerts"].values())
    has_crit = any(a["severity"] in ("critical", "high") for a in status["alerts"])
    sent_ok = True
    host = C.load_env().get("SERVER_NAME", "Six Star VPS")
    if due:
        worst = max(due, key=lambda a: SEV_RANK[a["severity"]])["severity"].upper()
        rows = "".join("<li><b>%s</b> - %s<br><i>Recommended: %s</i></li>" % (a["severity"].upper(), esc(a["message"]), esc(a.get("action") or "see the Infrastructure page")) for a in due)
        sent_ok = send_mail("[%s] %s: database infrastructure (%s)" % (host, worst, ", ".join(a["code"] for a in due)), "<p>Time: %s</p><ul>%s</ul><p>Open Admin &gt; Infrastructure &gt; Database. Critical alerts repeat every 6 hours until fixed. Credentials are never included in alerts.</p>" % (status["generatedAt"], rows))
    elif had_crit and not has_crit:
        sent_ok = send_mail("[%s] Database infrastructure alerts cleared" % host, "<p>All critical/high alerts have cleared (%s).</p>" % status["generatedAt"])
    if sent_ok:
        state["alerts"] = nxt
    # Send one detailed report per queued event; advance the cursor only after successful delivery.
    evs = C.read_jsonl(os.path.join(C.STATE, "history.jsonl"), 100)
    seen = state.get("lastEventTs", "")
    fresh = [e for e in evs if e.get("notify") and e.get("ts", "") > seen]
    duplicate_failure_events = {
        "backup_failed", "r2_upload_failed", "oplog_failed",
        "pitr_test_failed", "restore_test_failed", "verify_failed",
        "oplog_gap", "retention_failed",
    }
    for event in fresh:
        if event.get("kind") in duplicate_failure_events:
            state["lastEventTs"] = event["ts"]
            continue
        title, report_html, report_text = _event_report(host, event)
        if send_mail("[%s] %s" % (host, title), report_html, report_text):
            state["lastEventTs"] = event["ts"]
        else:
            break
    C.write_json(sp, state, 0o600)


def main():
    status = collect()
    C.write_json(os.path.join(C.STATE, "status.json"), status)
    try:
        notify(status)
    except Exception as e:
        C.event("notify_error", "warning", "alert delivery failed: %s" % str(e)[:150])
    return status
