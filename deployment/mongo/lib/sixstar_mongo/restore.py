"""restore.py - restore TESTS (throwaway mongod on port 27099, never production), point-in-time replay, the non-destructive RECOVERY instance (port 27098)
and the guarded, manual production promote.

Safety rules enforced here:
  * restore tests and PITR tests only ever touch a throwaway mongod on 127.0.0.1:27099 in the staging directory;
  * a recovery instance is a separate mongod (127.0.0.1:27098) - production is never written to while it is built;
  * promoting recovered data into production needs: maintenance mode ON, the typed confirmation, and a fresh verified safety backup of the CURRENT data first;
  * --oplogReplay is NEVER combined with namespace renaming (oplog entries are not renamed and would hit the live database)."""
import json, os, resource, shutil, signal, socket, subprocess, tempfile, time
from . import common as C
from . import backup as B
from . import resources as RES

SCRATCH_PORT = 27099
RECOVERY_PORT = 27098

COUNTS_JS = r"""
var out = {counts: {}, total: 0, invalid: []}; var n = 0;
db.adminCommand({listDatabases:1}).databases.forEach(function(d){
  if (['admin','local','config'].indexOf(d.name) >= 0) return; var x = db.getSiblingDB(d.name);
  x.getCollectionNames().forEach(function(c){
    if (c.indexOf('system.') === 0) return; var k = x.getCollection(c).estimatedDocumentCount(); out.counts[d.name+'.'+c] = k; out.total += k;
    if (k > 0) { try { var v = x.getCollection(c).validate({full:false}); if (!v.valid) out.invalid.push(d.name+'.'+c); } catch (e) { out.invalid.push(d.name+'.'+c+' ('+String(e).slice(0,60)+')'); } }
  }); });
return out;
"""


# ------------------------------------------------------------------ process helpers
def run_chain(cmds, envs=None, stdout=None):
    """Run cmds as a shell-less pipeline: cmd0 | cmd1 | ... Returns (exit codes, stderr tails). The last command writes to `stdout` (default: discarded)."""
    errs = [tempfile.TemporaryFile() for _ in cmds]
    procs, prev = [], None
    last = len(cmds) - 1
    for i, c in enumerate(cmds):
        p = subprocess.Popen(c, stdin=prev.stdout if prev else subprocess.DEVNULL, stdout=subprocess.PIPE if i < last else (stdout or subprocess.DEVNULL),
                             stderr=errs[i], env=(envs or {}).get(i))
        if prev:
            prev.stdout.close()
        procs.append(p)
        prev = p
    codes = [p.wait() for p in procs]
    tails = []
    for f in errs:
        f.seek(0)
        tails.append(f.read()[-300:].decode("utf8", "replace").strip())
        f.close()
    return codes, tails


def decrypt_cmds(key):
    return [["rclone", "cat", B.remote(key)], ["age", "-d", "-i", B.identity_file()], ["zstd", "-dc", "-q"]]


def _port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def uri(port):
    return "mongodb://127.0.0.1:%d/admin" % port


def _set_scratch_nofile_limit():
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    target = min(65536, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))


def start_mongod(dbpath, port, cache_gb, logfile):
    os.makedirs(dbpath, exist_ok=True)
    cmd = ["mongod", "--dbpath", dbpath, "--port", str(port), "--bind_ip", "127.0.0.1", "--wiredTigerCacheSizeGB", str(cache_gb), "--nounixsocket", "--quiet"]
    lf = open(logfile, "ab")
    p = subprocess.Popen(["nice", "-n", "15"] + cmd, stdout=lf, stderr=lf, start_new_session=True, preexec_fn=_set_scratch_nofile_limit)
    lf.close()
    for _ in range(90):
        if p.poll() is not None:
            raise RuntimeError("temporary mongod exited immediately (see %s)" % logfile)
        if _port_open(port):
            try:
                C.mongosh("return db.runCommand({ping:1}).ok;", uri=uri(port), timeout=20)
                return p
            except Exception:
                pass
        time.sleep(2)
    stop_pid(p)
    raise RuntimeError("temporary mongod did not become ready")


def stop_pid(process, expected_port=None):
    """Stop a mongod process and confirm termination before its data is removed."""
    proc = process if hasattr(process, "poll") and hasattr(process, "pid") else None
    pid = int(proc.pid if proc is not None else process)

    def exited():
        if proc is not None:
            return proc.poll() is not None
        try:
            os.kill(pid, 0)
            return False
        except ProcessLookupError:
            return True
        except PermissionError as e:
            raise RuntimeError("cannot inspect process %s: permission denied" % pid) from e

    if exited():
        return True

    # A persisted PID may have been reused. Only signal the expected recovery mongod.
    if proc is None and expected_port is not None:
        cmd_path = "/proc/%d/cmdline" % pid
        try:
            cmdline = open(cmd_path, "rb").read()
        except FileNotFoundError:
            return True
        except OSError as e:
            raise RuntimeError("cannot verify process identity for PID %s: %s" % (pid, e)) from e

        expected = b"--port\x00" + str(expected_port).encode("ascii") + b"\x00"
        if b"mongod\x00" not in cmdline or expected not in cmdline:
            raise RuntimeError(
                "PID %s is not the expected recovery mongod on port %s; refusing to signal it"
                % (pid, expected_port)
            )

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError as e:
        raise RuntimeError("cannot terminate process %s: permission denied" % pid) from e

    for _ in range(60):
        if exited():
            return True
        if proc is not None:
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        else:
            time.sleep(1)

    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    except PermissionError as e:
        raise RuntimeError("cannot force-stop process %s: permission denied" % pid) from e

    for _ in range(10):
        if exited():
            return True
        if proc is not None:
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        else:
            time.sleep(1)

    raise RuntimeError(
        "could not confirm process %s stopped after SIGKILL; preserving its data directory"
        % pid
    )


def _record(kind, status, detail, **extra):
    p = os.path.join(C.STATE, "restore-tests.json")
    cur = C.read_json(p, {}) or {}
    cur[kind] = {"status": status, "ts": C.iso(), "detail": detail[:400], **extra}
    C.write_json(p, cur)
    sev = "info" if status == "passed" else ("warning" if status == "skipped" else "critical")
    C.event("%s_test_%s" % (kind, status), sev, "%s: %s" % ("Restore test" if kind == "restore" else "Point-in-time recovery test", detail[:300]), notify=(status in ("failed", "passed")))


def _free_for(raw_bytes, path=None):
    d = C.disk(path or C.STAGING) or C.disk("/")
    return d["freeGb"] * 1073741824 >= raw_bytes * 1.3 + 1073741824


def _compare(manifest_counts, got):
    bad = []
    for ns, n in (manifest_counts or {}).items():
        r = got.get(ns)
        if r is None:
            if n > 0:
                bad.append("%s missing (expected ~%d)" % (ns, n))
        elif abs(r - n) > max(5, int(0.02 * n)):
            bad.append("%s has %d documents, backup manifest says ~%d" % (ns, r, n))
    return bad


# ------------------------------------------------------------------ core: backup -> scratch/recovery mongod
def pick_full(st, until=None):
    ch = st.get("chain") or {}
    vf = [f for f in st["fulls"] if f.get("verifiedAt") and not f.get("verifyError")]
    if until is None:
        return (vf[-1] if vf else None)
    cand = [f for f in vf if f.get("chain") == ch.get("id") and f["finishedAt"] <= until]
    return cand[-1] if cand else None


def segments_for(st, full):
    ch = st.get("chain") or {}
    st_t = (full["startTs"]["t"], full["startTs"]["i"])
    segs = sorted([s for s in st["segments"] if s["chain"] == full.get("chain") and (s["to"]["t"], s["to"]["i"]) > st_t], key=lambda x: x["seq"])
    if full.get("chain") != ch.get("id") or ch.get("brokenAt") or ch.get("contiguous") is False:
        return None, "the oplog chain for this backup is broken or not contiguous"
    if any(not s.get("verified") for s in segs):
        return None, "some oplog segments are not verified"
    prev = None
    for s in segs:
        if prev and (s["from"]["t"], s["from"]["i"]) != (prev["to"]["t"], prev["to"]["i"]):
            return None, "gap in oplog segments before segment %d" % s["seq"]
        prev = s
    return segs, None


def restore_into(port, full, segs=None, limit_epoch=None):
    """Full archive (+ its embedded oplog) then, optionally, the archived oplog segments up to limit_epoch. Target is a THROWAWAY/RECOVERY mongod, never production."""
    t0 = time.time()
    cmd = ["mongorestore", "--host", "127.0.0.1", "--port", str(port), "--archive", "--oplogReplay", "--quiet"]
    codes, errs = run_chain(decrypt_cmds(full["key"]) + [cmd], envs={0: B.rclone_env()})
    if any(codes):
        raise RuntimeError("restore of %s failed (%s): %s" % (full["id"], codes, " | ".join(e for e in errs if e)[:300]))
    applied = 0
    os.makedirs(C.STAGING, exist_ok=True)
    for s in (segs or []):
        d = tempfile.mkdtemp(prefix="seg-", dir=C.STAGING)
        try:
            fp = os.path.join(d, "oplog.bson")
            with open(fp, "wb") as f:
                codes, errs = run_chain(decrypt_cmds(s["key"]), envs={0: B.rclone_env()}, stdout=f)
            if any(codes) or os.path.getsize(fp) != s["rawBytes"]:
                raise RuntimeError("oplog segment %d could not be decrypted to its recorded size" % s["seq"])
            cmd = ["mongorestore", "--host", "127.0.0.1", "--port", str(port), "--oplogReplay", "--quiet"]
            if limit_epoch:
                cmd += ["--oplogLimit", "%d" % limit_epoch]
            p = subprocess.run(cmd + [d], capture_output=True, text=True, timeout=3600)
            if p.returncode != 0:
                raise RuntimeError("oplog replay of segment %d failed: %s" % (s["seq"], (p.stderr or p.stdout)[-200:]))
            applied += 1
        finally:
            shutil.rmtree(d, ignore_errors=True)
    return {"seconds": int(time.time() - t0), "segments": applied}


def _scratch_run(kind):
    lk = C.Lock("heavy")
    if not lk.acquire():
        return {"status": "busy"}
    scratch = os.path.join(C.STAGING, "restore-scratch")
    proc = None
    try:
        pre = B.preflight(need_mongo=False)
        if pre or not os.path.exists(B.identity_file()):
            _record(kind, "failed", pre or "age identity file is missing, so backups cannot be decrypted (%s)" % B.identity_file())
            return {"status": "failed", "error": pre or "no age identity"}
        prof, mode = RES.effective_backup_profile()
        if mode == "protective":
            return {"status": "deferred", "reason": "protective mode (server under pressure)"}
        st = B.S()
        full = pick_full(st)
        if not full:
            _record(kind, "failed", "no verified full backup exists to test")
            return {"status": "failed", "error": "no verified backup"}
        segs = None
        if kind == "pitr":
            segs, why = segments_for(st, full)
            if segs is None:
                _record(kind, "failed", why)
                return {"status": "failed", "error": why}
            if not segs:
                _record(kind, "skipped", "no oplog segments newer than the latest full backup yet")
                return {"status": "skipped"}
        if not _free_for(full.get("rawBytes", 0)):
            _record(kind, "skipped", "not enough free disk to restore a copy safely (needs ~1.3x the raw database size)")
            return {"status": "skipped"}
        os.makedirs(C.STAGING, exist_ok=True)
        if _port_open(SCRATCH_PORT):
            raise RuntimeError(
                "scratch MongoDB port is already active; refusing to delete or reuse its data directory"
            )
        shutil.rmtree(scratch, ignore_errors=True)
        proc = start_mongod(os.path.join(scratch, "db"), SCRATCH_PORT, 0.25, os.path.join(C.VAR, "scratch-mongod.log"))
        info = restore_into(SCRATCH_PORT, full, segs)
        res = C.mongosh(COUNTS_JS, uri=uri(SCRATCH_PORT), timeout=300)
        problems = _compare(full.get("counts"), res["counts"]) if kind == "restore" else []
        if kind == "pitr" and res["total"] < 0.98 * (full.get("totalDocs") or 0):
            problems.append("after replay only %d documents exist (backup had ~%d)" % (res["total"], full.get("totalDocs") or 0))
        problems += ["collection failed validation: " + n for n in res["invalid"]]
        if problems:
            _record(kind, "failed", "; ".join(problems)[:380], backupId=full["id"])
            return {"status": "failed", "problems": problems}
        _record(kind, "passed", "Backup %s restored: %d documents in %d collections, validation clean%s, %ds." % (
            full["id"], res["total"], len(res["counts"]), (", %d oplog segment(s) replayed" % info["segments"]) if kind == "pitr" else "", info["seconds"]), backupId=full["id"], durationSec=info["seconds"], documents=res["total"])
        return {"status": "passed", "backupId": full["id"], "documents": res["total"]}
    except Exception as e:
        _record(kind, "failed", C.redact(str(e))[:380])
        return {"status": "failed", "error": C.redact(str(e))[:240]}
    finally:
        cleanup_error = None
        try:
            if proc:
                stop_pid(proc)
                if _port_open(SCRATCH_PORT):
                    raise RuntimeError(
                        "scratch MongoDB port remains active after process shutdown"
                    )
        except Exception as e:
            cleanup_error = e

        try:
            if cleanup_error is None and not _port_open(SCRATCH_PORT):
                shutil.rmtree(scratch, ignore_errors=True)
            else:
                _record(
                    kind,
                    "failed",
                    "MongoDB shutdown could not be confirmed; scratch data preserved: %s"
                    % C.redact(str(cleanup_error))[:250],
                )
        finally:
            lk.release()

        if cleanup_error is not None:
            raise RuntimeError(
                "scratch MongoDB shutdown was not confirmed; its data directory was preserved"
            ) from cleanup_error


def restore_test():
    return _scratch_run("restore")


def pitr_test():
    return _scratch_run("pitr")


# ------------------------------------------------------------------ recovery instance (non-destructive restore, optionally to a point in time)
def _rec_state():
    return C.read_json(os.path.join(C.VAR, "recovery.json"), None)


def recover(backup_id="latest", until_iso=None):
    """Build a separate mongod (127.0.0.1:27098) holding the recovered data. Production is untouched. Inspect it with:
         mongosh mongodb://127.0.0.1:27098     |   then `restore promote` (guarded) or `restore discard`."""
    lk = C.Lock("heavy")
    if not lk.acquire():
        return {"status": "busy"}
    try:
        cur = _rec_state()
        if cur and _port_open(RECOVERY_PORT):
            return {"status": "exists", "detail": "A recovery instance is already running (built %s). Run `restore discard` first." % cur.get("builtAt")}
        if cur:
            # Clean up a stale recovery record only after its recorded process is confirmed stopped.
            if cur.get("pid"):
                stop_pid(cur["pid"], expected_port=RECOVERY_PORT)
            stale_dir = os.path.join(C.VAR, "recovery")
            shutil.rmtree(stale_dir, ignore_errors=True)
            try:
                os.remove(os.path.join(C.VAR, "recovery.json"))
            except FileNotFoundError:
                pass
        pre = B.preflight(need_mongo=False)
        if pre:
            return {"status": "failed", "error": pre}
        st = B.S()
        until_epoch = None
        if until_iso:
            ts = C.parse_iso(until_iso)
            if ts is None:
                return {"status": "failed", "error": "bad --until timestamp (use e.g. 2026-11-13T09:15:00Z)"}
            rec = B.recovery(st)
            if not rec.get("chainOk") or not (C.parse_iso(rec["pitrFrom"]) <= ts <= C.parse_iso(rec["pitrUntil"])):
                return {"status": "failed", "error": "That time is outside the VERIFIED point-in-time window (%s .. %s)." % (rec.get("pitrFrom"), rec.get("pitrUntil"))}
            full = pick_full(st, until_iso)
            until_epoch = int(ts) + 1
            segs, why = segments_for(st, full) if full else (None, "no verified full backup before that time")
            if segs is None:
                return {"status": "failed", "error": why}
        else:
            full = pick_full(st) if backup_id == "latest" else next((f for f in st["fulls"] if f["id"] == backup_id and f.get("verifiedAt")), None)
            segs = None
        if not full:
            return {"status": "failed", "error": "no verified backup matches"}
        if not _free_for(full.get("rawBytes", 0), C.VAR):
            return {"status": "failed", "error": "not enough free disk for a recovery copy"}
        d = os.path.join(C.VAR, "recovery")
        shutil.rmtree(d, ignore_errors=True)
        p = start_mongod(os.path.join(d, "db"), RECOVERY_PORT, 0.25, os.path.join(C.VAR, "recovery-mongod.log"))
        try:
            info = restore_into(RECOVERY_PORT, full, segs, until_epoch)
            res = C.mongosh(COUNTS_JS, uri=uri(RECOVERY_PORT), timeout=300)
            status = "failed" if res.get("invalid") else "ok"
        except Exception as recovery_error:
            try:
                stop_pid(p)
            except Exception as stop_error:
                # Preserve recovery data and make a best-effort PID record.
                record_error = None
                try:
                    C.write_json(
                        os.path.join(C.VAR, "recovery.json"),
                        {
                            "builtAt": C.iso(),
                            "backupId": full["id"],
                            "until": until_iso,
                            "pid": p.pid,
                            "documents": 0,
                            "invalid": [],
                            "cleanupFailed": True,
                        },
                        0o600,
                    )
                except Exception as error:
                    record_error = error

                message = (
                    "Recovery mongod shutdown could not be confirmed; recovery data was preserved: "
                    + C.redact(str(stop_error))[:200]
                )
                if record_error is not None:
                    message += "; recovery PID record could not be saved: " + C.redact(str(record_error))[:120]

                try:
                    C.event("recovery_cleanup_failed", "critical", message, notify=True)
                except Exception as event_error:
                    recovery_error.cleanup_event_error = C.redact(str(event_error))[:160]

                # Keep the original recovery failure primary.
                raise recovery_error from stop_error

            shutil.rmtree(d, ignore_errors=True)
            raise
        C.write_json(os.path.join(C.VAR, "recovery.json"), {"builtAt": C.iso(), "backupId": full["id"], "until": until_iso, "pid": p.pid, "documents": res["total"], "invalid": res["invalid"]}, 0o600)
        C.event("recovery_built", "warning", "Recovery instance built from backup %s%s (%d documents). Production was not modified." % (full["id"], " + oplog to " + until_iso if until_iso else "", res["total"]), notify=True)
        return {"status": status, "port": RECOVERY_PORT, "backupId": full["id"], "documents": res["total"], "invalid": res["invalid"], "seconds": info["seconds"]}
    except Exception as e:
        try:
            C.event(
                "recovery_failed",
                "critical",
                "Recovery instance could not be built: " + C.redact(str(e))[:250],
                notify=True,
            )
        except Exception as event_error:
            return {
                "status": "failed",
                "error": C.redact(str(e))[:170]
                + "; failure event logging also failed: "
                + C.redact(str(event_error))[:60],
            }
        return {"status": "failed", "error": C.redact(str(e))[:240]}
    finally:
        lk.release()


def discard():
    cur = _rec_state()

    if _port_open(RECOVERY_PORT):
        if not cur or not cur.get("pid"):
            return {
                "status": "refused",
                "error": "Recovery port is active but its process identity is unavailable; refusing to delete recovery data.",
            }

    if cur and cur.get("pid"):
        try:
            stop_pid(cur["pid"], expected_port=RECOVERY_PORT)
        except Exception as e:
            return {
                "status": "failed",
                "error": "Recovery process shutdown could not be confirmed; recovery data was preserved: "
                + C.redact(str(e))[:200],
            }

        if _port_open(RECOVERY_PORT):
            return {
                "status": "failed",
                "error": "Recovery port remains active after process shutdown; recovery data was preserved.",
            }

    shutil.rmtree(os.path.join(C.VAR, "recovery"), ignore_errors=True)
    try:
        os.remove(os.path.join(C.VAR, "recovery.json"))
    except FileNotFoundError:
        pass
    return {"status": "discarded"}


def promote(db, confirm, worker_stopped=False):
    """Replace the LIVE database `db` with the recovery instance's copy. Refuses unless every guard passes. A verified safety backup of the current data is taken first."""
    if confirm != "REPLACE %s" % db:
        return {"status": "refused", "error": 'Type the exact phrase: --confirm "REPLACE %s"' % db}
    if not os.path.exists(os.path.join(C.BASE, "shared/maintenance.flag")):
        return {"status": "refused", "error": "Turn maintenance mode ON first (Admin > Infrastructure > Controls)."}
    if not worker_stopped:
        return {"status": "refused", "error": "Stop the background worker first (pm2 stop sixstar-worker) and pass --worker-stopped."}
    cur = _rec_state()
    if not cur or not _port_open(RECOVERY_PORT):
        return {"status": "refused", "error": "No recovery instance is running. Run `restore recover` first."}
    if cur.get("invalid"):
        return {"status": "refused", "error": "The recovery copy has collections that failed validation: %s" % ", ".join(cur["invalid"][:5])}
    admin = C.load_env(os.path.join(C.ETC, "mongo-admin.env")).get("MONGO_ADMIN_URI")
    if not admin:
        return {"status": "refused", "error": "MONGO_ADMIN_URI missing in %s/mongo-admin.env" % C.ETC}
    safety = B.full(manual=True)
    if safety.get("status") != "ok":
        return {"status": "refused", "error": "Safety backup of the current database failed, so nothing was changed: %s" % safety.get("error", safety.get("status"))}
    st = B.S()
    if not next((f for f in st["fulls"] if f["id"] == safety["id"] and f.get("verifiedAt")), None):
        return {"status": "refused", "error": "Safety backup %s is not verified, so nothing was changed." % safety["id"]}
    cfg = os.path.join(C.VAR, "promote.yml")
    try:
        with open(os.open(cfg, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write('uri: "%s"\n' % admin)
        codes, errs = run_chain([["mongodump", "--host", "127.0.0.1", "--port", str(RECOVERY_PORT), "--db", db, "--archive", "--quiet"],
                                 ["mongorestore", "--config", cfg, "--archive", "--drop", "--nsInclude", "%s.*" % db, "--quiet"]])
    finally:
        try:
            os.remove(cfg)
        except FileNotFoundError:
            pass
    if any(codes):
        C.event("promote_failed", "critical", "Promote failed (%s). Safety backup %s holds the previous data." % (codes, safety["id"]), notify=True)
        return {"status": "failed", "error": " | ".join(e for e in errs if e)[:300], "safetyBackup": safety["id"]}
    C.event("promote_ok", "warning", "Database %s was replaced from the recovery copy. Previous data is in safety backup %s." % (db, safety["id"]), notify=True)
    return {"status": "ok", "safetyBackup": safety["id"], "next": "Restart the API slots and worker, check /health/db, then turn maintenance off. Run `restore discard` when done."}
