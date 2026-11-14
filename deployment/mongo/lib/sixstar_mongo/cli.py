"""cli.py - `sixstar-mongoctl`: the single entry point used by cron, the installer, the operator and (through sudo + sixstar-ops) the super-admin dashboard.
Exit code 0 = ok / nothing to do, 1 = failed, 2 = refused (a safety guard said no), 3 = busy (another job of the same kind is running)."""
import argparse, json, os, sys
from . import common as C


def out(obj):
    print(json.dumps(obj, indent=2, default=str))
    st = obj.get("status") if isinstance(obj, dict) else None
    return {"failed": 1, "refused": 2, "busy": 3}.get(st, 0)


def build():
    p = argparse.ArgumentParser(prog="sixstar-mongoctl", description="Six Star POS - MongoDB Community infrastructure control")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resources", help="detect VPS resources and (re)apply safe MongoDB / Node settings")
    r.add_argument("--plan", action="store_true", help="show what would change, apply nothing")
    r.add_argument("--force", action="store_true")
    r.add_argument("--print-cache-gb", action="store_true", help="print only the calculated WiredTiger cache (used by the installer)")
    sub.add_parser("guardian", help="one monitoring pass: health, storage, alerts, e-mail (cron: every minute)")
    sub.add_parser("status", help="print the last guardian status")
    b = sub.add_parser("backup")
    b.add_argument("kind", choices=["full", "oplog"])
    b.add_argument("--manual", action="store_true", help="start now even if the server is busy")
    b.add_argument("--force", action="store_true")
    v = sub.add_parser("verify")
    v.add_argument("target", nargs="?", default="latest")
    rt = sub.add_parser("retention")
    rt.add_argument("--dry-run", action="store_true")
    sub.add_parser("recovery", help="show the verified recovery points")
    sub.add_parser("restore-test")
    sub.add_parser("pitr-test")
    rs = sub.add_parser("restore")
    rs.add_argument("action", choices=["recover", "discard", "promote"])
    rs.add_argument("backup", nargs="?", default="latest")
    rs.add_argument("--until")
    rs.add_argument("--db")
    rs.add_argument("--confirm")
    rs.add_argument("--worker-stopped", action="store_true")
    sub.add_parser("txn-test", help="prove multi-document transactions work (commit + abort) as the application's role")
    m = sub.add_parser("migrate", help="Atlas -> Community migration")
    m.add_argument("step", choices=["audit", "backup", "stage", "reconcile", "delta", "cutover", "rollback", "finalize", "status"])
    m.add_argument("--target", choices=["staging", "prod"], default="staging")
    m.add_argument("--since")
    m.add_argument("--apply", action="store_true")
    m.add_argument("--reverse", action="store_true")
    m.add_argument("--confirm")
    m.add_argument("--no-sync-back", action="store_true")
    h = sub.add_parser("hold", help="pause the watchdog restart (use during planned maintenance)")
    h.add_argument("state", choices=["on", "off"])
    return p


def main(argv):
    a = build().parse_args(argv)
    if os.geteuid() != 0 and not os.environ.get("SIXSTAR_ALLOW_NONROOT"):
        print("sixstar-mongoctl must run as root (use sudo).", file=sys.stderr)
        return 2
    os.makedirs(C.VAR, exist_ok=True)
    os.makedirs(C.STATE, exist_ok=True)
    c = a.cmd
    if c == "resources":
        from . import resources as R
        if a.print_cache_gb:
            print(R.calculate(R.detect())["mongoCacheGb"])
            return 0
        res = R.check(apply=not a.plan, force=a.force)
        return out({"status": "ok", "mode": res["mode"], "detected": res["detected"], "profile": res["profile"], "lastChange": res.get("lastChange")})
    if c == "guardian":
        from . import guardian as G
        s = G.main()
        print("%s  alerts=%d" % (s["health"], len(s["alerts"])))
        for x in s["alerts"]:
            print(" - [%s] %s" % (x["severity"], x["message"]))
        return 1 if s["health"] == "critical" else 0
    if c == "status":
        return out(C.read_json(os.path.join(C.STATE, "status.json"), {"status": "failed", "error": "guardian has not run yet"}))
    if c == "backup":
        from . import backup as B
        return out(B.full(manual=a.manual) if a.kind == "full" else B.oplog(force=a.force))
    if c == "verify":
        from . import backup as B
        return out(B.verify(a.target))
    if c == "retention":
        from . import backup as B
        return out(B.retention(apply=not a.dry_run))
    if c == "recovery":
        from . import backup as B
        return out(B.recovery())
    if c in ("restore-test", "pitr-test"):
        from . import restore as RS
        return out(RS.restore_test() if c == "restore-test" else RS.pitr_test())
    if c == "restore":
        from . import restore as RS
        if a.action == "recover":
            return out(RS.recover(a.backup, a.until))
        if a.action == "discard":
            return out(RS.discard())
        if not a.db:
            return out({"status": "refused", "error": "--db <database name> is required"})
        return out(RS.promote(a.db, a.confirm, a.worker_stopped))
    if c == "txn-test":
        from . import migrate as MG
        return out(MG.txn_test())
    if c == "migrate":
        from . import migrate as MG
        s = a.step
        if s == "audit":
            return out(MG.audit(a.target))
        if s == "backup":
            return out(MG.backup(a.target))
        if s == "stage":
            return out(MG.stage())
        if s == "reconcile":
            return out(MG.reconcile(a.target))
        if s == "delta":
            return out(MG.delta(a.since, a.apply, a.reverse))
        if s == "cutover":
            return out(MG.cutover(a.confirm))
        if s == "rollback":
            return out(MG.rollback(not a.no_sync_back, a.confirm))
        if s == "finalize":
            return out(MG.finalize())
        return out(MG.status())
    if c == "hold":
        p = os.path.join(C.VAR, "maintenance.hold")
        if a.state == "on":
            open(p, "w").write(C.iso())
        elif os.path.exists(p):
            os.remove(p)
        print("watchdog hold:", a.state)
        return 0
    return 2
