"""backup.py - encrypted nightly full backups + continuous oplog archiving to Cloudflare R2, verification, recovery-point calculation and retention.
Pipeline (streamed, so a 2 GB VPS never needs a second copy of the data on disk):  mongodump --archive --oplog | zstd | age | sha256+size | file or rclone rcat.
A backup counts only when: archive uploaded + remote size matches + manifest written. A recovery point is advertised only when verified (see recovery())."""
import hashlib, os, re, shutil, subprocess, threading, time, json
from . import common as C
from . import resources as RES

STATE_F = lambda: os.path.join(C.STATE, "backups.json")
BASE_RETRY = [30, 120, 300]


# ------------------------------------------------------------------ config / tools
def env():
    return C.load_env()


def remote(path=""):
    base = os.environ.get("SIXSTAR_RCLONE_BASE")                       # tests: ":local:/tmp/dir"
    if base:
        return base.rstrip("/") + "/" + path
    return "r2:%s/%s" % (C.conf()["bucket"], path)


def rclone_env():
    e = env(); out = dict(os.environ)
    if not os.environ.get("SIXSTAR_RCLONE_BASE"):
        out.update({"RCLONE_CONFIG_R2_TYPE": "s3", "RCLONE_CONFIG_R2_PROVIDER": "Cloudflare", "RCLONE_CONFIG_R2_ACCESS_KEY_ID": e.get("R2_ACCESS_KEY_ID", ""),
                    "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY": e.get("R2_SECRET_ACCESS_KEY", ""), "RCLONE_CONFIG_R2_ENDPOINT": "https://%s.r2.cloudflarestorage.com" % e.get("R2_ACCOUNT_ID", ""),
                    "RCLONE_CONFIG_R2_REGION": "auto", "RCLONE_CONFIG_R2_ACL": "private", "RCLONE_CONFIG_R2_NO_CHECK_BUCKET": "true"})
    out["RCLONE_CONFIG"] = os.devnull
    return out


def rc(args, timeout=3600, input=None):
    return C.run(["rclone"] + args, timeout, rclone_env(), input)


def recipients_file():
    return os.environ.get("SIXSTAR_AGE_RECIPIENTS", os.path.join(C.ETC, "age-recipients.txt"))


def identity_file():
    return os.environ.get("SIXSTAR_AGE_IDENTITY", os.path.join(C.ETC, "age-identity.txt"))


def preflight(need_mongo=True):
    miss = [t for t in ("zstd", "age", "rclone") + (("mongodump", "mongosh") if need_mongo else ()) if shutil.which(t) is None]
    if miss:
        return "missing tools: " + ", ".join(miss)
    if not os.path.exists(recipients_file()):
        return "no age recipients file (%s)" % recipients_file()
    if not os.environ.get("SIXSTAR_RCLONE_BASE"):
        e = env()
        if not all(e.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")):
            return "R2 credentials are not set in %s" % C.ENV_FILE
    if need_mongo and not env().get("MONGO_OPS_URI"):
        return "MONGO_OPS_URI is not set in %s" % C.ENV_FILE
    return None


def S():
    return C.read_json(STATE_F(), None) or {"fulls": [], "pending": [], "chain": None, "segments": [], "r2": {}, "lastError": None, "lastOplog": None, "events": []}


def save(st):
    st["updatedAt"] = C.iso()
    C.write_json(STATE_F(), st)


def fail(kind, msg, sev="critical", **extra):
    st = S()
    st["lastError"] = {"kind": kind, "ts": C.iso(), "message": C.redact(msg)[:300], **extra}
    save(st)
    C.event(kind + "_failed", sev, C.redact(msg)[:300], notify=True)


# ------------------------------------------------------------------ the streaming pipeline
def pipeline(src_cmd, sink, prof):
    """src_cmd -> zstd -> age -> sink. Returns dict(sha256, size, raw)."""
    nice = ["nice", "-n", str(prof.get("nice", 19))]
    if shutil.which("ionice"):
        nice += ["ionice", "-c3"]

    names = ("dump.err", "zstd.err", "age.err", "sink.err")
    err_paths = [os.path.join(C.VAR, n) for n in names]
    errs = [open(path, "wb") for path in err_paths]

    src = zst = age = sink_p = None
    out = None
    feeder = None
    raw = [0]
    feed_errors = []
    h, size = hashlib.sha256(), 0

    processes = []

    def stop_processes():
        for proc in reversed(processes):
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:
                    pass
        for proc in reversed(processes):
            if proc:
                try:
                    proc.wait(timeout=5)
                except Exception:
                    try:
                        proc.kill()
                        proc.wait(timeout=5)
                    except Exception:
                        pass

    try:
        if sink[0] == "file":
            out = open(sink[1], "wb")
        elif sink[0] == "rcat":
            sink_p = subprocess.Popen(
                [
                    "rclone", "rcat", remote(sink[1]),
                    "--s3-upload-concurrency",
                    str(prof.get("uploadConcurrency", 1)),
                    "--s3-chunk-size",
                    "%dM" % prof.get("chunkMb", 8),
                    "--retries", "1"
                ],
                stdin=subprocess.PIPE,
                stderr=errs[3],
                env=rclone_env()
            )
            processes.append(sink_p)
            out = sink_p.stdin
        else:
            raise ValueError("unsupported backup sink: %s" % sink[0])

        src = subprocess.Popen(
            nice + src_cmd,
            stdout=subprocess.PIPE,
            stderr=errs[0],
            env=dict(os.environ, **{"LC_ALL": "C"})
        )
        processes.append(src)

        zst = subprocess.Popen(
            nice + [
                "zstd",
                "-T%d" % prof.get("zstdThreads", 1),
                "-%d" % prof.get("zstdLevel", 3),
                "-q", "-c"
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=errs[1]
        )
        processes.append(zst)

        age = subprocess.Popen(
            ["age", "-R", recipients_file()],
            stdin=zst.stdout,
            stdout=subprocess.PIPE,
            stderr=errs[2]
        )
        processes.append(age)
        zst.stdout.close()

        def feed():
            try:
                while True:
                    chunk = src.stdout.read(1048576)
                    if not chunk:
                        break
                    raw[0] += len(chunk)
                    zst.stdin.write(chunk)
            except BrokenPipeError:
                pass
            except Exception as exc:
                feed_errors.append(exc)
            finally:
                try:
                    zst.stdin.close()
                except Exception:
                    pass
                try:
                    src.stdout.close()
                except Exception:
                    pass

        feeder = threading.Thread(target=feed, daemon=True)
        feeder.start()

        while True:
            chunk = age.stdout.read(1048576)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
            out.write(chunk)

        out.close()
        out = None

        feeder.join()

        codes = {
            "dump": src.wait(),
            "zstd": zst.wait(),
            "age": age.wait()
        }
        if sink_p:
            codes["upload"] = sink_p.wait()

        if feed_errors:
            raise RuntimeError("backup data feeder failed: %s" % feed_errors[0])

        bad = [name for name, code in codes.items() if code != 0]
        if bad:
            for f in errs:
                f.flush()

            error_names = {
                "dump": "dump.err",
                "zstd": "zstd.err",
                "age": "age.err",
                "upload": "sink.err"
            }
            detail = []
            for name in bad:
                path = os.path.join(C.VAR, error_names[name])
                try:
                    with open(path, "rb") as f:
                        message = f.read()[-500:].decode("utf-8", "replace").strip()
                except Exception as exc:
                    message = "could not read error log: %s" % exc
                detail.append("%s: %s" % (name, message or "no error output"))

            raise RuntimeError(
                "pipeline failed (%s) %s" % (",".join(bad), " | ".join(detail))
            )

        if size == 0 or raw[0] == 0:
            raise RuntimeError("pipeline produced an empty archive")

    except BaseException:
        if out is not None:
            try:
                out.close()
            except Exception:
                pass

        for proc in (src, zst, age, sink_p):
            if proc:
                for stream in (proc.stdin, proc.stdout):
                    if stream:
                        try:
                            stream.close()
                        except Exception:
                            pass

        stop_processes()

        if feeder and feeder.is_alive():
            feeder.join(timeout=5)

        raise

    finally:
        for f in errs:
            try:
                f.close()
            except Exception:
                pass

    return {"sha256": h.hexdigest(), "size": size, "raw": raw[0]}


def retry(fn, what):
    last = None
    for i, d in enumerate([0] + BASE_RETRY):
        if d:
            time.sleep(float(os.environ.get("SIXSTAR_RETRY_SLEEP", d)))
        try:
            return fn()
        except Exception as e:
            last = e
    raise RuntimeError("%s failed after retries: %s" % (what, last))


def put_file(path, key, prof):
    def go():
        code, out, err = rc(["copyto", path, remote(key), "--s3-upload-concurrency", str(prof.get("uploadConcurrency", 1)), "--s3-chunk-size", "%dM" % prof.get("chunkMb", 8), "--transfers", "1", "--retries", "3"], 7200)
        if code != 0:
            raise RuntimeError(err[-200:] or out[-200:])
        remote_size(key, os.path.getsize(path))
    retry(go, "upload " + key)


def remote_size(key, expect=None):
    code, out, err = rc(["lsjson", remote(key)], 120)
    if code != 0:
        raise RuntimeError("remote check failed: " + err[-150:])
    items = json.loads(out or "[]")
    if not items:
        raise RuntimeError("object %s not found in R2" % key)
    if expect is not None and items[0]["Size"] != expect:
        raise RuntimeError("size mismatch for %s: R2 has %d, expected %d" % (key, items[0]["Size"], expect))
    return items[0]["Size"]


def put_json(obj, key):
    tmp = os.path.join(C.VAR, "up.json")
    partial = tmp + ".tmp"

    try:
        with open(partial, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())

        os.replace(partial, tmp)

        code, out, err = rc(
            ["copyto", tmp, remote(key), "--retries", "3"], 300
        )
        if code != 0:
            raise RuntimeError(
                "manifest upload failed: " + (err or out)[-150:]
            )
    finally:
        if os.path.exists(partial):
            os.remove(partial)


# ------------------------------------------------------------------ Mongo helpers
SNAP_JS = r"""
var o = db.getSiblingDB('local').oplog.rs;
var lastRows = o.find().sort({$natural:-1}).limit(1).toArray();
var firstRows = o.find().sort({$natural:1}).limit(1).toArray();
if (!lastRows.length || !firstRows.length) {
  throw new Error("MongoDB oplog is empty; cannot establish backup snapshot");
}
var last = lastRows[0].ts;
var first = firstRows[0].ts;
var counts = {}; var total = 0; var dataMb = 0;
var dbList = db.adminCommand({listDatabases:1});
if (!dbList || dbList.ok !== 1 || !Array.isArray(dbList.databases)) {
  throw new Error("Cannot list MongoDB databases; check backup account permissions");
}
dbList.databases.forEach(function(d){ if (['admin','local','config'].indexOf(d.name) >= 0) return; var x = db.getSiblingDB(d.name);
  dataMb += Math.round(x.stats().dataSize/1048576);
  x.getCollectionNames().forEach(function(c){ if (c.indexOf('system.')===0) return; var n = x.getCollection(c).estimatedDocumentCount(); counts[d.name+'.'+c] = n; total += n; }); });
return {last: {t: last.t, i: last.i}, first: {t: first.t, i: first.i}, counts: counts, total: total, dataMb: dataMb};
"""


def snapshot():
    return C.mongosh(SNAP_JS, timeout=120)


def ts_of(t):
    return "%d_%d" % (t["t"], t["i"])


def ts_json(t):
    return '{"$timestamp":{"t":%d,"i":%d}}' % (t["t"], t["i"])


# ------------------------------------------------------------------ oplog chain
def ensure_chain(snap):
    st = S()
    ch = st.get("chain")
    if not ch or ch.get("brokenAt"):
        n = (ch or {}).get("gen", 0) + 1
        ch = {"id": "c%03d" % n, "gen": n, "startTs": snap["last"], "lastTs": snap["last"], "coveredUntil": C.iso(), "brokenAt": None, "seq": 0}
        st["chain"] = ch
        save(st)
    return ch


def oplog(force=False):
    if C.conf().get("oplogIntervalMin", 15) <= 0:
        return {"status": "disabled"}
    lk = C.Lock("oplog")
    if not lk.acquire():
        return {"status": "busy"}
    try:
        st = S()
        if not force and st.get("lastOplog") and C.now() - (C.parse_iso(st["lastOplog"]["ts"]) or 0) < C.conf()["oplogIntervalMin"] * 60 - 20:
            return {"status": "too-soon"}
        pre = preflight()
        if pre:
            return {"status": "not-configured", "reason": pre}
        snap = snapshot()
        ch = st.get("chain")
        if not ch or ch.get("brokenAt"):
            ch = ensure_chain(snap)
            st = S()
            return {"status": "chain-started", "chain": ch["id"]}
        last, end = ch["lastTs"], snap["last"]
        if (snap["first"]["t"], snap["first"]["i"]) > (last["t"], last["i"]):                       # the oplog rolled over: a gap
            ch["brokenAt"] = C.iso()
            st["chain"] = ch
            save(st)
            C.event("oplog_gap", "high", "Oplog archiving fell behind: the oplog no longer contains the last archived position. Point-in-time recovery chain %s is broken; a new chain starts with the next full backup." % ch["id"], notify=True)
            return {"status": "gap"}
        if (end["t"], end["i"]) == (last["t"], last["i"]):
            ch["coveredUntil"] = C.iso()
            st["chain"] = ch
            st["lastOplog"] = {"ts": C.iso(), "empty": True}
            save(st)
            return {"status": "idle"}
        prof, _ = RES.effective_backup_profile()
        d = os.path.join(C.STAGING, "oplog-%d" % os.getpid())
        os.makedirs(d, exist_ok=True)
        try:
            q = '{"ts":{"$gt":%s,"$lte":%s}}' % (ts_json(last), ts_json(end))
            code, out, err = C.run(["mongodump", "--uri", env()["MONGO_OPS_URI"], "--db", "local", "--collection", "oplog.rs", "--query", q, "--out", d, "--quiet"], 600)
            f = os.path.join(d, "local", "oplog.rs.bson")
            if code != 0 or not os.path.exists(f):
                raise RuntimeError("oplog dump failed: " + C.redact(err)[-200:])
            ch["seq"] += 1
            key = "oplog/%s/%06d_%s_to_%s.bson.zst.age" % (ch["id"], ch["seq"], ts_of(last), ts_of(end))
            staged = os.path.join(d, "seg.age")
            meta = pipeline(["cat", f], ("file", staged), prof)
            put_file(staged, key, prof)
            remote_size(key, meta["size"])

            seg = {
                "key": key, "seq": ch["seq"], "chain": ch["id"],
                "from": last, "to": end, "sizeBytes": meta["size"],
                "rawBytes": meta["raw"], "sha256": meta["sha256"],
                "ts": C.iso(), "verified": False
            }

            # Both remote manifests must be saved before local PITR state advances.
            put_json(seg, key + ".json")

            next_ch = dict(ch)
            next_ch["lastTs"] = end
            next_ch["coveredUntil"] = C.iso()

            put_json(
                {"chain": next_ch, "updatedAt": C.iso()},
                "oplog/%s/chain.json" % next_ch["id"]
            )

            st = S()
            st["chain"] = next_ch
            st["segments"].append(seg)
            st["lastOplog"] = {
                "ts": C.iso(), "key": key, "sizeBytes": meta["size"]
            }
            if st.get("lastError") and st["lastError"].get("kind") in ("oplog", "oplog_upload"):
                st["lastError"] = None
            save(st)
            return {"status": "archived", "key": key, "bytes": meta["size"]}
        finally:
            shutil.rmtree(d, ignore_errors=True)
    except Exception as e:
        fail("oplog", str(e), "high")
        return {"status": "failed", "error": C.redact(str(e))[:200]}
    finally:
        lk.release()


# ------------------------------------------------------------------ full backup
def free_ok(last_size):
    d = C.disk(C.STAGING) or C.disk("/")
    need = max(1.0, 1.5 * last_size / 1073741824)
    return d["freeGb"] >= need + 1.0 and d["usedPct"] < 90


def new_id():
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def full(manual=False):
    lk = C.Lock("heavy")
    if not lk.acquire():
        return {"status": "busy"}
    bid = new_id()
    try:
        pre = preflight()
        if pre:
            fail("backup", pre)
            return {"status": "failed", "error": pre}
        os.makedirs(C.STAGING, exist_ok=True)
        prof, mode = RES.effective_backup_profile()
        if not manual:                                                    # adaptive scheduling: wait (up to 20 min) while the shop is busy
            waited = 0
            while os.getloadavg()[1] > (os.cpu_count() or 1) * 1.5 and waited < 1200:
                time.sleep(float(os.environ.get("SIXSTAR_LOAD_WAIT", 60)))
                waited += 60
                if os.environ.get("SIXSTAR_LOAD_WAIT"):
                    break
        pending_failures = retry_pending(prof)
        if pending_failures:
            return {"status": "pending-upload", "pending": pending_failures}
        snap = snapshot()
        ch = ensure_chain(snap)
        snap = snapshot()                                                  # startTs is taken AFTER the chain exists, so every full is anchored
        start_ts = snap["last"]
        t0 = time.time()
        st = S()
        last_size = max([f.get("sizeBytes", 0) for f in st["fulls"]] or [0])
        key = "full/%s.archive.zst.age" % bid
        cmd = ["mongodump", "--uri", env()["MONGO_OPS_URI"], "--archive", "--oplog", "--numParallelCollections", str(prof.get("dumpParallelCollections", 1)), "--quiet"]
        staged = os.path.join(C.STAGING, bid + ".archive.zst.age")
        stage = free_ok(last_size)
        if stage:
            meta = pipeline(cmd, ("file", staged), prof)
        else:
            C.event("backup_streaming", "warning", "Low free disk: streaming the backup straight to R2 without a local copy (no local retry possible).")
            meta = pipeline(cmd, ("rcat", key), prof)

        m = {"id": bid, "type": "full", "key": key, "startedAt": C.iso(t0), "finishedAt": C.iso(), "durationSec": int(time.time() - t0), "sizeBytes": meta["size"], "rawBytes": meta["raw"], "sha256": meta["sha256"],
             "compression": "zstd", "encryption": "age", "mongoVersion": S().get("mongoVersion"), "counts": snap["counts"], "totalDocs": snap["total"], "dataMb": snap["dataMb"],
             "chain": ch["id"], "startTs": start_ts, "uploaded": True, "verifiedAt": None, "profile": mode}

        if stage:
            pend = {"id": bid, "path": staged, "key": key, "manifest": m}
            st = S()
            if not any(x.get("id") == bid for x in st["pending"]):
                st["pending"].append(pend)
            save(st)
            try:
                put_file(staged, key, prof)
                remote_size(key, meta["size"])
                put_json(m, "full/%s.json" % bid)
            except Exception as e:
                fail("r2_upload", str(e))
                return {"status": "upload-failed", "id": bid, "error": C.redact(str(e))[:200]}
        else:
            remote_size(key, meta["size"])
            put_json(m, "full/%s.json" % bid)

        st = S()
        if not any(x.get("id") == bid for x in st["fulls"]):
            st["fulls"].append(m)
        st["pending"] = [x for x in st["pending"] if x.get("id") != bid]
        st["lastError"] = None if (st.get("lastError") or {}).get("kind") in ("backup", "r2_upload") else st.get("lastError")
        save(st)

        if stage and os.path.exists(staged):
            os.remove(staged)
        C.event("backup_ok", "info", "Full backup %s completed: %.1f MB encrypted, %d documents, %ds." % (bid, meta["size"] / 1048576.0, snap["total"], m["durationSec"]), notify=True, id=bid)
        try:
            usage()
        except Exception:
            pass
        if C.conf().get("verifyDeepAfterBackup", True) and mode == "normal":
            verify(bid)
        return {"status": "ok", "id": bid, "bytes": meta["size"]}
    except Exception as e:
        fail("backup", str(e))
        return {"status": "failed", "error": C.redact(str(e))[:240]}
    finally:
        lk.release()


def retry_pending(prof):
    st = S()
    failures = []

    for p in list(st["pending"]):
        bid = p.get("id", "unknown")
        path = p.get("path")
        manifest = p.get("manifest")

        if not path or not os.path.isfile(path):
            message = "Local staged backup file is missing; pending record retained."
            p["lastError"] = message
            p["status"] = "missing-local-file"
            failures.append({"id": bid, "error": message})
            save(st)
            continue

        if not isinstance(manifest, dict) or not manifest.get("key") or not manifest.get("sizeBytes"):
            message = "Pending record has no complete manifest; retained for manual recovery."
            p["lastError"] = message
            p["status"] = "needs-manual-recovery"
            failures.append({"id": bid, "error": message})
            save(st)
            continue

        try:
            put_file(path, p["key"], prof)
            remote_size(p["key"], manifest["sizeBytes"])
            put_json(manifest, "full/%s.json" % bid)

            current = S()
            if not any(x.get("id") == bid for x in current["fulls"]):
                current["fulls"].append(manifest)
            current["pending"] = [x for x in current["pending"] if x.get("id") != bid]
            save(current)

            if os.path.isfile(path):
                os.remove(path)

            C.event("upload_retry_ok", "info", "Previously failed upload %s completed and its manifest was saved." % bid)
        except Exception as e:
            message = C.redact(str(e))[:200]
            p["lastError"] = message
            p["status"] = "retry-failed"
            failures.append({"id": bid, "error": message})
            current = S()
            for item in current["pending"]:
                if item.get("id") == bid:
                    item.update(p)
            save(current)

    return failures


# ------------------------------------------------------------------ verification
def stream_hash(key):
    p = subprocess.Popen(["rclone", "cat", remote(key)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=rclone_env())
    h, n = hashlib.sha256(), 0
    while True:
        b = p.stdout.read(1048576)
        if not b:
            break
        h.update(b); n += len(b)
    return p.wait(), h.hexdigest(), n


def decrypt_size(key):
    r = subprocess.Popen(["rclone", "cat", remote(key)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=rclone_env())
    a = subprocess.Popen(["age", "-d", "-i", identity_file()], stdin=r.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    r.stdout.close()
    z = subprocess.Popen(["zstd", "-dc", "-q"], stdin=a.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    a.stdout.close()
    n = 0
    while True:
        b = z.stdout.read(1048576)
        if not b:
            break
        n += len(b)
    rc_z = z.wait()
    rc_a = a.wait()
    rc_r = r.wait()
    return rc_r == 0 and rc_a == 0 and rc_z == 0, n


def verify(target="latest"):
    """Deep verification: object exists, size and SHA-256 match the manifest, and it decrypts + decompresses to the recorded raw size.
    (A full restore is proven separately by restore-test; see restore.py.)"""
    st = S()
    fulls = [f for f in st["fulls"] if f.get("uploaded")]
    if target == "latest":
        cand = fulls[-1:] if fulls else []
    elif target == "unverified":
        cand = [f for f in fulls if not f.get("verifiedAt")][-1:]
    else:
        if not re.fullmatch(r"\d{8}T\d{6}Z", target):
            raise ValueError("bad backup id")
        cand = [f for f in fulls if f["id"] == target]
    if not cand:
        return {"status": "nothing-to-verify"}
    m = cand[0]
    try:
        remote_size(m["key"], m["sizeBytes"])
        code, sha, n = stream_hash(m["key"])
        if code != 0 or sha != m["sha256"] or n != m["sizeBytes"]:
            raise RuntimeError("checksum mismatch for %s (expected %s..., got %s...)" % (m["id"], m["sha256"][:12], sha[:12]))
        ident = identity_file()
        if not os.path.isfile(ident):
            raise RuntimeError(
                "encryption identity file is missing; deep verification cannot be completed"
            )

        ok, raw = decrypt_size(m["key"])
        if not ok or raw != m["rawBytes"]:
            raise RuntimeError(
                "backup %s does not decrypt/decompress to the recorded size" % m["id"]
            )
        st = S()
        for f in st["fulls"]:
            if f["id"] == m["id"]:
                f["verifiedAt"] = C.iso(); f["verifyError"] = None
        save(st)
        C.event("verify_ok", "info", "Backup %s verified (checksum + decrypt + decompress)." % m["id"], id=m["id"])
        verify_chain()
        return {"status": "ok", "id": m["id"]}
    except Exception as e:
        st = S()
        for f in st["fulls"]:
            if f["id"] == m["id"]:
                f["verifyError"] = C.redact(str(e))[:200]
        save(st)
        C.event("verify_failed", "high", "Backup verification failed: " + C.redact(str(e))[:250], notify=True, id=m["id"])
        return {"status": "failed", "error": C.redact(str(e))[:200]}


def verify_chain(limit=40):
    """Verify chain continuity and prioritize unverified segments."""
    st = S()
    ch = st.get("chain")
    if not ch:
        return {"status": "nothing-to-verify"}

    segs = sorted(
        [s for s in st["segments"] if s.get("chain") == ch["id"]],
        key=lambda s: s["seq"]
    )

    # Deep-verify only pending segments; continuity is checked across all.
    candidates = sorted(
        [s for s in segs if not s.get("verified")],
        key=lambda s: s["seq"]
    )[:limit]
    selected = {s["seq"] for s in candidates}

    prev = None
    good = True
    checked = 0

    for seg in segs:
        seg_from = (seg["from"]["t"], seg["from"]["i"])
        seg_to = (seg["to"]["t"], seg["to"]["i"])

        if seg_to <= seg_from:
            good = False

        if prev is not None:
            if seg_from != (prev["to"]["t"], prev["to"]["i"]):
                good = False
            if seg["seq"] != prev["seq"] + 1:
                good = False

        if seg["seq"] in selected:
            try:
                remote_size(seg["key"], seg["sizeBytes"])
                code, sha, size = stream_hash(seg["key"])
                if code != 0 or sha != seg["sha256"] or size != seg["sizeBytes"]:
                    raise RuntimeError("oplog segment checksum or size mismatch")

                if not os.path.isfile(identity_file()):
                    raise RuntimeError("encryption identity file is missing")

                ok, raw = decrypt_size(seg["key"])
                if not ok or raw != seg["rawBytes"]:
                    raise RuntimeError("oplog segment decrypt/decompress verification failed")

                seg["verified"] = True
                seg["verifyError"] = None

            except Exception as e:
                seg["verified"] = False
                seg["verifyError"] = C.redact(str(e))[:200]
                good = False

            checked += 1
        elif not seg.get("verified"):
            good = False

        prev = seg

    pending = sum(1 for s in segs if not s.get("verified"))
    ch["contiguous"] = good
    st["chain"] = ch
    save(st)

    return {
        "status": "ok" if good and pending == 0 else "failed",
        "chain": ch["id"],
        "segments": len(segs),
        "checked": checked,
        "verified": len(segs) - pending,
        "pending": pending,
        "contiguous": good
    }


def verify_chain_job():
    """Standalone scheduled verifier, serialized against full and oplog backups."""
    heavy = C.Lock("heavy")
    if not heavy.acquire():
        return {"status": "busy", "lock": "heavy"}

    oplog_lock = C.Lock("oplog")
    try:
        if not oplog_lock.acquire():
            return {"status": "busy", "lock": "oplog"}
        try:
            return verify_chain()
        finally:
            oplog_lock.release()
    finally:
        heavy.release()


def recovery(st=None):
    """Report PITR only when verified segments fully cover the recovery interval."""
    st = st or S()
    ch = st.get("chain") or {}

    vf = [
        f for f in st["fulls"]
        if f.get("verifiedAt") and not f.get("verifyError")
    ]

    out = {
        "fullOnly": None,
        "pitrUntil": None,
        "pitrFrom": None,
        "chain": ch.get("id"),
        "chainOk": False
    }

    if not vf:
        return out

    f = vf[-1]
    out["fullOnly"] = f.get("finishedAt")
    out["fullId"] = f.get("id")

    if (
        not ch
        or ch.get("brokenAt")
        or f.get("chain") != ch.get("id")
        or ch.get("contiguous") is not True
    ):
        return out

    try:
        full_start = (f["startTs"]["t"], f["startTs"]["i"])
        chain_start = (ch["startTs"]["t"], ch["startTs"]["i"])
        chain_end = (ch["lastTs"]["t"], ch["lastTs"]["i"])

        if chain_start > full_start or chain_end < full_start:
            return out

        segs = sorted(
            [
                s for s in st["segments"]
                if s.get("chain") == ch["id"]
                and (s["to"]["t"], s["to"]["i"]) > full_start
            ],
            key=lambda s: s["seq"]
        )

        if not segs:
            return out

        # The first segment must bridge the full backup's oplog position.
        first_from = (segs[0]["from"]["t"], segs[0]["from"]["i"])
        first_to = (segs[0]["to"]["t"], segs[0]["to"]["i"])

        if not (first_from <= full_start < first_to):
            return out

        previous_to = None
        previous_seq = None

        for seg in segs:
            seg_from = (seg["from"]["t"], seg["from"]["i"])
            seg_to = (seg["to"]["t"], seg["to"]["i"])

            if not seg.get("verified") or seg_to <= seg_from:
                return out

            if previous_to is not None:
                if seg_from != previous_to:
                    return out
                if seg["seq"] != previous_seq + 1:
                    return out

            previous_to = seg_to
            previous_seq = seg["seq"]

        # The verified chain must reach its recorded final oplog position.
        if previous_to != chain_end:
            return out

        if not ch.get("coveredUntil"):
            return out

        out["chainOk"] = True
        out["pitrFrom"] = f.get("finishedAt")
        out["pitrUntil"] = ch["coveredUntil"]
        return out

    except (KeyError, TypeError, ValueError, IndexError):
        return out


# ------------------------------------------------------------------ retention (daily / weekly / monthly) + R2 usage
def keep_set(fulls, ret, now_ts=None):
    """Select full backups according to daily, weekly, monthly and minimum retention."""
    items = sorted(fulls, key=lambda f: f["id"])
    keep_min = max(0, int(ret.get("keepMinFull", 0)))
    daily = max(0, int(ret.get("daily", 0)))
    weekly = max(0, int(ret.get("weekly", 0)))
    monthly = max(0, int(ret.get("monthly", 0)))

    keep = set(f["id"] for f in items[-keep_min:]) if keep_min else set()
    ids = {
        f["id"]: time.mktime(time.strptime(f["id"], "%Y%m%dT%H%M%SZ")) - time.timezone
        for f in items
    }

    day = {}
    for f in items:
        day.setdefault(f["id"][:8], f["id"])
    if daily:
        for d in sorted(day)[-daily:]:
            keep.add(day[d])

    wk, mo = {}, {}
    for f in items:
        t = time.gmtime(ids[f["id"]])
        wk.setdefault((t.tm_year, time.strftime("%W", t)), f["id"])
        mo.setdefault(f["id"][:6], f["id"])

    if weekly:
        for k in sorted(wk)[-weekly:]:
            keep.add(wk[k])
    if monthly:
        for k in sorted(mo)[-monthly:]:
            keep.add(mo[k])

    return keep


def retention(apply=True):
    lk = C.Lock("heavy")
    if not lk.acquire():
        return {"status": "busy"}
    try:
        ret = C.conf()["retention"]
        code, out, err = rc(["lsjson", remote("full/")], 300)
        if code != 0:
            raise RuntimeError("cannot list R2 (nothing deleted): " + err[-150:])

        objs = json.loads(out or "[]")
        manifests = {
            o["Name"][:-5]: o for o in objs
            if o["Name"].endswith(".json")
        }
        archives = {
            o["Name"].split(".")[0]: o for o in objs
            if o["Name"].endswith(".age")
        }

        st = S()
        complete = [
            f for f in st["fulls"]
            if f["id"] in manifests and f["id"] in archives
        ]
        incomplete = [
            f["id"] for f in st["fulls"]
            if f["id"] not in manifests or f["id"] not in archives
        ]

        keep = keep_set(complete, ret)
        verified = [f for f in complete if f.get("verifiedAt")]
        if verified:
            keep.add(verified[-1]["id"])

        doomed = [f["id"] for f in complete if f["id"] not in keep]
        orphans = [
            i for i, o in archives.items()
            if i not in manifests
            and C.now() - (
                C.parse_iso(o.get("ModTime", "")[:19] + "Z") or C.now()
            ) > 2 * 86400
        ]

        deleted = []
        failures = []

        if apply:
            current = S()
            removed_ids = set()

            for bid in doomed:
                archive_key = "full/%s.archive.zst.age" % bid
                manifest_key = "full/%s.json" % bid

                archive_rc, _, archive_err = rc(
                    ["deletefile", remote(archive_key)], 120
                )
                if archive_rc != 0:
                    failures.append({
                        "id": bid,
                        "object": "archive",
                        "error": C.redact(archive_err)[-150:]
                    })
                    continue

                manifest_rc, _, manifest_err = rc(
                    ["deletefile", remote(manifest_key)], 120
                )
                if manifest_rc != 0:
                    failures.append({
                        "id": bid,
                        "object": "manifest",
                        "error": C.redact(manifest_err)[-150:]
                    })
                    continue

                deleted.append(bid)
                removed_ids.add(bid)

            for bid in orphans:
                key = "full/%s.archive.zst.age" % bid
                orphan_rc, _, orphan_err = rc(
                    ["deletefile", remote(key)], 120
                )
                if orphan_rc != 0:
                    failures.append({
                        "id": bid,
                        "object": "orphan",
                        "error": C.redact(orphan_err)[-150:]
                    })

            # Preserve all oplog segments until PITR dependencies are mapped.
            current["fulls"] = [
                f for f in current["fulls"]
                if f["id"] not in removed_ids
            ]
            save(current)
            usage()

            C.event(
                "retention_done",
                "warning" if failures else "info",
                "Retention completed: %d backup(s) removed, %d incomplete backup(s) preserved, %d deletion failure(s), %d oplog segment(s) preserved." % (
                    len(deleted), len(incomplete), len(failures),
                    len(current.get("segments", []))
                ),
                notify=True
            )

        return {
            "status": "partial" if failures else "ok",
            "keep": sorted(keep),
            "delete": doomed,
            "deleted": deleted,
            "orphans": orphans,
            "incomplete": incomplete,
            "failures": failures,
            "oplogSegmentsDeleted": 0,
            "applied": apply
        }
    except Exception as e:
        C.event("retention_failed", "warning", C.redact(str(e))[:250], notify=True)
        return {"status": "failed", "error": C.redact(str(e))[:200]}
    finally:
        lk.release()



def usage():
    code, out, err = rc(["size", "--json", remote("")], 300)
    st = S()
    if code == 0:
        j = json.loads(out)
        st["r2"] = {"objects": j.get("count"), "sizeGb": round(j.get("bytes", 0) / 1073741824, 3), "ts": C.iso(), "error": None}
    else:
        st["r2"] = {**st.get("r2", {}), "error": err[-120:], "ts": C.iso()}
    save(st)


# ------------------------------------------------------------------ dashboard / guardian view
def view():
    st = S()
    cf = C.conf()
    alerts = []
    inst = shutil.which("mongod") is not None
    pre = preflight(need_mongo=False) if inst else None
    fulls = [f for f in st["fulls"] if f.get("uploaded")]
    last = fulls[-1] if fulls else None
    rec = recovery(st)
    rt = C.read_json(os.path.join(C.STATE, "restore-tests.json"), {}) or {}
    v = {"configured": inst and pre is None, "encrypted": True, "configProblem": pre, "lastFull": None, "fulls": [], "chain": None, "recovery": rec, "restoreTest": rt.get("restore"), "pitrTest": rt.get("pitr"),
         "r2": st.get("r2", {}), "lastError": st.get("lastError"), "pending": len(st.get("pending", [])), "retention": cf["retention"], "lastOplog": st.get("lastOplog")}
    for f in reversed(fulls[-30:]):
        v["fulls"].append({"id": f["id"], "ts": f["finishedAt"], "sizeMb": round(f["sizeBytes"] / 1048576, 1), "docs": f.get("totalDocs"), "durationSec": f.get("durationSec"), "verifiedAt": f.get("verifiedAt"), "verifyError": f.get("verifyError"), "chain": f.get("chain")})
    if last:
        v["lastFull"] = v["fulls"][0]
    ch = st.get("chain")
    if ch:
        v["chain"] = {"id": ch["id"], "ok": rec["chainOk"], "broken": bool(ch.get("brokenAt")), "coveredUntil": ch.get("coveredUntil"), "segments": len([s for s in st["segments"] if s["chain"] == ch["id"]]), "contiguous": ch.get("contiguous")}
    if not inst:
        return v, alerts
    if pre:
        alerts.append(("backup_unconfigured", "high", "Backups are not configured: " + pre, "Finish section 4 of the install guide (R2 keys, age key)."))
        return v, alerts
    le = st.get("lastError") or {}
    if le.get("kind") == "r2_upload":
        alerts.append(("r2_upload_failed", "critical", "R2 upload failed: " + le.get("message", ""), "Check R2 credentials / network; a staged copy is kept and retried automatically."))
    elif le.get("kind") == "backup":
        alerts.append(("backup_failed", "critical", "Backup failed: " + le.get("message", ""), "Run: sudo sixstar-mongoctl backup full and read the output."))
    elif le.get("kind") in ("oplog", "oplog_upload"):
        alerts.append(("oplog_failed", "high", "Oplog archiving failed: " + le.get("message", ""), "Point-in-time recovery coverage is not advancing."))
    age_h = (C.now() - C.parse_iso(last["finishedAt"])) / 3600 if last else None
    if not last:
        alerts.append(("backup_none", "critical", "No backup exists yet. Run the first full backup.", "sudo sixstar-mongoctl backup full"))
    elif age_h > cf["fullBackupMaxAgeHours"]:
        alerts.append(("backup_old", "critical", "Last successful full backup is %.0f hours old." % age_h, "Check the nightly job and R2 connectivity."))
    if last and last.get("verifyError"):
        alerts.append(("verify_failed", "high", "Backup %s failed verification: %s" % (last["id"], last["verifyError"]), "Run verify again; if it fails again take a new backup."))
    elif last and not last.get("verifiedAt") and age_h > 6:
        alerts.append(("verify_pending", "warning", "The newest backup has not been verified yet.", "sudo sixstar-mongoctl verify latest"))
    if ch and ch.get("brokenAt"):
        alerts.append(("chain_broken", "high", "The oplog archive chain is broken: point-in-time recovery is unavailable until the next full backup.", "Run a full backup."))
    for k, label in (("restore", "Restore test"), ("pitr", "Point-in-time recovery test")):
        t = rt.get(k)
        if t and t.get("status") == "failed":
            alerts.append((k + "_test_failed", "critical", "%s FAILED: %s - backups may not be recoverable." % (label, t.get("detail", "")[:150]), "Read restore-test.log, take a new backup."))
        elif last and (not t or C.now() - (C.parse_iso(t.get("ts")) or 0) > cf["restoreTestMaxAgeDays"] * 86400):
            alerts.append((k + "_test_old", "warning", "%s has not passed in the last %d days." % (label, cf["restoreTestMaxAgeDays"]), "sudo sixstar-mongoctl %s-test" % k))
    # Keep a retention warning active until a later successful retention run.
    retention_events = [
        e for e in C.read_jsonl(os.path.join(C.STATE, "history.jsonl"), 100)
        if e.get("kind") in ("retention_failed", "retention_done")
    ]
    if retention_events:
        latest_retention = max(retention_events, key=lambda e: e.get("ts", ""))
        if latest_retention.get("kind") == "retention_failed":
            alerts.append((
                "retention_failed",
                "warning",
                "Backup retention failed: " + str(latest_retention.get("message", ""))[:200],
                "Inspect the retention error, disk usage and storage permissions. Correct the cause before retrying. Do not manually delete backup or oplog files."
            ))

    return v, alerts
