"""migrate.py - Atlas -> MongoDB Community migration tooling.

Guarantees (see the runbook):
  * Atlas is only ever READ by audit / backup / stage / cutover. It is never dropped, restored into or modified (the only write to Atlas is the optional, rule-guarded
    `rollback` sync-back, which inserts/updates documents that were created on the new database after cutover).
  * Cutover refuses to restore into a production database that already contains documents - nothing newer is ever overwritten.
  * The delta engine never overwrites a newer document with an older one (it compares updatedAt/createdAt) and reports conflicts instead of resolving them silently.
  * If any verification step fails, production stays on (or returns to) the old database automatically.
Credentials are passed to the tools through 0600 config files or environment variables, never on the command line."""
import json, os, pwd, re, shlex, shutil, time, urllib.error, urllib.request
from . import common as C
from . import backup as B
from . import resources as RES

STATE_F = lambda: os.path.join(C.STATE, "migration.json")
MIG_DIR = lambda: os.path.join(C.VAR, "migration")
ARCHIVE_DIR = os.environ.get("SIXSTAR_MIGRATION_DIR", "/var/backups/sixstar/migration")
STEPS = ["audit", "backup", "stage", "reconcile", "cutover", "delta", "finalize"]


# ------------------------------------------------------------------ state + config
def M():
    return C.read_json(STATE_F(), None) or {"steps": {}, "phase": "not_started"}


def mark(step, status, detail="", **extra):
    m = M()
    m["steps"][step] = {"status": status, "ts": C.iso(), "detail": detail[:400], **extra}
    if status == "ok":
        m["phase"] = step
    m["updatedAt"] = C.iso()
    C.write_json(STATE_F(), m)
    C.event("migration_" + step + "_" + status, "info" if status == "ok" else "high", "Migration step '%s' %s. %s" % (step, status, detail[:200]), notify=(status != "ok" or step in ("cutover", "finalize")))
    return m


def mig_env():
    e = C.load_env(os.path.join(C.ETC, "migration.env"))
    e.update({k: v for k, v in C.load_env(os.path.join(C.ETC, "mongo-admin.env")).items() if v})
    return e


def db_name(uri):
    m = re.match(r"^mongodb(?:\+srv)?://(?:[^@/]*@)?[^/?]+/([^?]*)", uri or "")
    return (m.group(1) if m and m.group(1) else "test")


def prod_db(e):
    """Name of the production database on Community: PROD_DB, else the database in APP_MONGODB_URI, else the Atlas database name."""
    if e.get("PROD_DB"):
        return e["PROD_DB"]
    if e.get("APP_MONGODB_URI"):
        return db_name(e["APP_MONGODB_URI"])
    return e.get("ATLAS_DB") or db_name(e.get("ATLAS_URI", ""))


def need(e, *keys):
    miss = [k for k in keys if not e.get(k)]
    if miss:
        raise RuntimeError("missing in /etc/sixstar/migration.env or mongo-admin.env: " + ", ".join(miss))



def atlas_source(e, target):
    """Return the explicitly configured Atlas source for the requested environment."""
    if target == "staging":
        need(e, "STAGING_ATLAS_URI")
        uri = e["STAGING_ATLAS_URI"]
        db = e.get("STAGING_ATLAS_DB") or db_name(uri)
    elif target == "prod":
        need(e, "ATLAS_URI")
        uri = e["ATLAS_URI"]
        db = e.get("ATLAS_DB") or db_name(uri)
    else:
        raise RuntimeError("target must be staging or prod")
    return uri, db


def cfg_file(uri):
    import json
    from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, unquote
    parts = urlsplit(uri)
    query = parse_qsl(parts.query, keep_blank_values=True)
    if parts.path not in ("", "/"):
        if parts.username is not None and not any(k.lower() == "authsource" for k, v in query):
            query.append(("authSource", unquote(parts.path.lstrip("/").split("/", 1)[0])))
        parts = parts._replace(path="/", query=urlencode(query))
        uri = urlunsplit(parts)
    os.makedirs(MIG_DIR(), exist_ok=True)
    p = os.path.join(MIG_DIR(), "cfg-%d-%d.yml" % (os.getpid(), int(time.time() * 1000) % 100000))
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("uri: %s\n" % json.dumps(uri))
    return p

def rm(p):
    try:
        os.remove(p)
    except Exception:
        pass


def mongosh_env(script, variables, timeout=3600):
    """Run a script in `mongosh --nodb`; the script reads connection strings from process.env (so they never appear in the process list)."""
    env = dict(os.environ)
    env.update(variables)
    wrapped = "print(EJSON.stringify((function(){%s})(), {relaxed:true}))" % script
    rc, out, err = C.run(["mongosh", "--quiet", "--norc", "--nodb", "--eval", wrapped], timeout, env)
    if rc != 0:
        raise RuntimeError(("mongosh: " + C.redact(err or out))[:400])
    return json.loads([l for l in out.splitlines() if l.strip()][-1])


# ------------------------------------------------------------------ 1. audit
AUDIT_JS = r"""
var d = Mongo(process.env.SRC_URI).getDB(process.env.SRC_DB);
var bi = d.adminCommand({buildInfo:1}); var hello = d.adminCommand({hello:1});
var cols = d.getCollectionInfos({}).filter(function(c){return c.name.indexOf('system.')!==0;}).map(function(c){
  var o = {name:c.name, type:c.type, capped: !!(c.options && c.options.capped)};
  if (c.type === 'collection') { var s = d.getCollection(c.name).stats(); o.count = s.count; o.sizeMb = Math.round(s.size/1048576*10)/10; o.storageMb = Math.round(s.storageSize/1048576*10)/10;
    o.indexes = d.getCollection(c.name).getIndexes().map(function(i){return {name:i.name, key:i.key, unique:!!i.unique, sparse:!!i.sparse, ttl:i.expireAfterSeconds===undefined?null:i.expireAfterSeconds};}); }
  return o; });
var st = d.stats();
return {version: bi.version, replicaSet: hello.setName || null, db: d.getName(), collections: cols, dataMb: Math.round(st.dataSize/1048576), storageMb: Math.round(st.storageSize/1048576), indexMb: Math.round(st.indexSize/1048576),
  docs: cols.reduce(function(a,c){return a+(c.count||0);},0), indexCount: cols.reduce(function(a,c){return a+((c.indexes||[]).length);},0)};
"""


def audit(target="prod"):
    e = mig_env()
    uri, src_db = atlas_source(e, target)
    state_key = "audit_" + target
    try:
        a = mongosh_env(AUDIT_JS, {"SRC_URI": uri, "SRC_DB": src_db}, 600)
    except Exception as ex:
        mark(state_key, "failed", str(ex))
        return {"status": "failed", "error": str(ex)[:300]}
    local = {"ramMb": RES.detect()["ramMb"], "freeGb": (C.disk(C.DATA_DIR) or C.disk("/"))["freeGb"]}
    notes = []
    need_gb = a["dataMb"] / 1024.0 * 3 + 2
    if local["freeGb"] < need_gb:
        notes.append("Free disk %.1f GB is below the %.1f GB needed for the staging copy + production copy + encrypted archive." % (local["freeGb"], need_gb))
    if a["replicaSet"] is None:
        notes.append("Source is not a replica set (unexpected for Atlas).")
    notes.append("The backend uses multi-document transactions, so MongoDB Community runs as a single-node replica set (rs0). Run `sixstar-mongoctl txn-test` before cutover.")
    out = {"status": "ok", "target": target, "source": {k: a[k] for k in ("version", "db", "dataMb", "storageMb", "indexMb", "docs", "indexCount")}, "collections": len(a["collections"]), "local": local, "notes": notes}
    C.write_json(os.path.join(C.STATE, "migration-audit-%s.json" % target), {"audit": a, "target": target, "ts": C.iso()})
    mark(state_key, "ok" if not any("below" in n for n in notes) else "failed", "Atlas %s, %d collections, %d docs, %d MB data. %s" % (a["version"], len(a["collections"]), a["docs"], a["dataMb"], " ".join(n for n in notes if "below" in n)), db=src_db)
    return out


# ------------------------------------------------------------------ 2. encrypted Atlas backup (independent recovery copy of the source)
def backup(target="prod"):
    e = mig_env()
    uri, src_db = atlas_source(e, target)
    state_key = "backup_" + target
    pre = B.preflight(need_mongo=False)
    r2_ok = not (pre and "R2" in pre)
    if pre and not r2_ok:
        pre = None
    if pre:
        mark(state_key, "failed", pre)
        return {"status": "failed", "error": pre}
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    os.chmod(ARCHIVE_DIR, 0o700)
    os.makedirs(C.VAR, exist_ok=True)
    prof, _ = RES.effective_backup_profile()
    bid = target + "-atlas-" + B.new_id()
    path = os.path.join(ARCHIVE_DIR, bid + ".archive.zst.age")
    cfg = cfg_file(uri)
    try:
        meta = B.pipeline(["mongodump", "--config", cfg, "--db", src_db, "--archive", "--readPreference", "secondaryPreferred", "--quiet"], ("file", path), prof)
    except Exception as ex:
        mark(state_key, "failed", C.redact(str(ex)))
        return {"status": "failed", "error": C.redact(str(ex))[:300]}
    finally:
        rm(cfg)
    rec = {"id": bid, "target": target, "db": src_db, "path": path, "sizeBytes": meta["size"], "rawBytes": meta["raw"], "sha256": meta["sha256"], "ts": C.iso(), "r2Key": None}
    if r2_ok:
        try:
            key = "migration/%s/%s.archive.zst.age" % (target, bid)
            B.put_file(path, key, prof)
            B.put_json(rec, "migration/%s/%s.json" % (target, bid))
            rec["r2Key"] = key
        except Exception as ex:
            rec["r2Error"] = C.redact(str(ex))[:200]
    mark(state_key, "ok", "Atlas %s backup %s: %.1f MB encrypted%s." % (target, bid, meta["size"] / 1048576.0, ", copied to R2" if rec["r2Key"] else ", LOCAL ONLY (R2 not configured/failed)"), archive=bid, r2=bool(rec["r2Key"]), db=src_db)
    C.write_json(os.path.join(MIG_DIR(), "latest-%s-atlas-backup.json" % target), rec, 0o600)
    return {"status": "ok", **rec}


# ------------------------------------------------------------------ restore helpers
def _stream_copy(src_uri, src_db, dst_uri, dst_db, prof, drop=False):
    """mongodump (source) | mongorestore (destination) with no copy of the data on disk. Source is only read."""
    from .restore import run_chain
    sc, dc = cfg_file(src_uri), cfg_file(dst_uri)
    try:
        dump = ["mongodump", "--config", sc, "--db", src_db, "--archive", "--readPreference", "primary", "--quiet"]
        rest = ["mongorestore", "--config", dc, "--archive", "--nsInclude", "%s.*" % src_db, "--numParallelCollections", str(prof.get("dumpParallelCollections", 1)), "--quiet"]
        if src_db != dst_db:
            rest += ["--nsFrom", "%s.*" % src_db, "--nsTo", "%s.*" % dst_db]
        if drop:
            rest.append("--drop")
        codes, errs = run_chain([["nice", "-n", "10"] + dump, ["nice", "-n", "10"] + rest])
    finally:
        rm(sc)
        rm(dc)
    if any(codes):
        raise RuntimeError("copy failed (exit codes %s): %s" % (codes, C.redact(" | ".join(x for x in errs if x))[:300]))


# ------------------------------------------------------------------ 3. reconcile (counts, indexes, sampled documents, business sums)
RECONCILE_JS = r"""
var S = Mongo(process.env.SRC_URI).getDB(process.env.SRC_DB), D = Mongo(process.env.DST_URI).getDB(process.env.DST_DB);
var tol = parseFloat(process.env.TOL_PCT || '0'), N = parseInt(process.env.SAMPLE || '300');
var PAT = /(total|amount|balance|qty|quantity|stock|price|cost|paid|due|tax|discount|credit|debit)/i;
function names(db){ return db.getCollectionInfos({}).filter(function(c){return c.name.indexOf('system.')!==0;}).map(function(c){return c.name;}).sort(); }
function norm(ix){ return JSON.stringify(ix.map(function(i){return {n:i.name,k:i.key,u:!!i.unique,s:!!i.sparse,p:i.partialFilterExpression||null,t:i.expireAfterSeconds===undefined?null:i.expireAfterSeconds};}).sort(function(a,b){return a.n<b.n?-1:1;})); }
function isNum(v){ return typeof v === 'number' || (v && ['Decimal128','Int32','Long','Double'].indexOf(v._bsontype) >= 0); }
var sn = names(S), dn = names(D), res = {ok:true, collections:[], missing:[], extra:[], totals:{src:0,dst:0}};
sn.forEach(function(n){ if (dn.indexOf(n) < 0) { res.missing.push(n); res.ok = false; } });
dn.forEach(function(n){ if (sn.indexOf(n) < 0) { res.extra.push(n); if (tol === 0) res.ok = false; } });
sn.forEach(function(n){
  if (dn.indexOf(n) < 0) return;
  var sc = S.getCollection(n), dc = D.getCollection(n), r = {ns:n, problems:[]};
  r.src = sc.countDocuments({}); r.dst = dc.countDocuments({}); res.totals.src += r.src; res.totals.dst += r.dst;
  if (tol === 0 ? r.src !== r.dst : Math.abs(r.src - r.dst) > Math.max(2, r.src * tol / 100)) r.problems.push('count ' + r.src + ' vs ' + r.dst);
  if (norm(sc.getIndexes()) !== norm(dc.getIndexes())) r.problems.push('indexes differ');
  var diff = 0, checked = 0;
  if (r.src > 0) { sc.aggregate([{$sample:{size:N}}]).forEach(function(doc){ checked++; var o = dc.findOne({_id:doc._id}); if (!o || EJSON.stringify(o) !== EJSON.stringify(doc)) diff++; }); }
  r.sampled = checked; r.sampleDiff = diff;
  if (diff > (tol === 0 ? 0 : Math.ceil(checked * tol / 100))) r.problems.push(diff + ' of ' + checked + ' sampled documents differ');
  var one = sc.findOne(); r.sums = [];
  if (one) { Object.keys(one).forEach(function(f){ if (f === '_id' || !PAT.test(f) || !isNum(one[f])) return;
    var agg = function(c){ var x = c.aggregate([{$group:{_id:null,s:{$sum:{$convert:{input:'$'+f,to:'double',onError:0,onNull:0}}}}}]).toArray(); return x.length ? x[0].s : 0; };
    var a = agg(sc), b = agg(dc), ok = Math.abs(a-b) <= Math.max(0.005, Math.abs(a) * (tol === 0 ? 1e-9 : tol/100));
    r.sums.push({f:f, src:a, dst:b, ok:ok}); if (!ok) r.problems.push('sum(' + f + ') ' + a + ' vs ' + b); }); }
  r.ok = r.problems.length === 0; if (!r.ok) res.ok = false; res.collections.push(r);
});
return res;
"""


def reconcile(target="staging", tol=None):
    """target: staging (Atlas is live, small drift allowed) | prod (exact: Atlas is frozen)."""
    e = mig_env()
    src_uri, src_db = atlas_source(e, target)
    need(e, "STAGING_MONGODB_URI" if target == "staging" else "MONGO_ADMIN_URI")
    dst_uri = e["STAGING_MONGODB_URI"] if target == "staging" else e["MONGO_ADMIN_URI"]
    dst_db = db_name(e["STAGING_MONGODB_URI"]) if target == "staging" else prod_db(e)
    if tol is None:
        tol = 1.0 if target == "staging" else 0.0
    try:
        r = mongosh_env(RECONCILE_JS, {"SRC_URI": src_uri, "SRC_DB": src_db, "DST_URI": dst_uri, "DST_DB": dst_db, "TOL_PCT": str(tol)}, 3600)
    except Exception as ex:
        mark("reconcile_" + target, "failed", str(ex), target=target)
        return {"status": "failed", "error": str(ex)[:300]}
    C.write_json(os.path.join(C.STATE, "reconcile-%s.json" % target), {"ts": C.iso(), "target": target, "tolerancePct": tol, **r})
    bad = [c for c in r["collections"] if not c["ok"]]
    detail = "%s: %d collections, %d docs vs %d. %s" % (target, len(r["collections"]), r["totals"]["src"], r["totals"]["dst"], "ALL CHECKS PASSED" if r["ok"] else "%d collection(s) differ%s%s" % (
        len(bad), "; missing: " + ",".join(r["missing"]) if r["missing"] else "", "; first: %s %s" % (bad[0]["ns"], "; ".join(bad[0]["problems"])) if bad else ""))
    if target == "prod":
        m = M()
        m["steps"]["reconcile_prod"] = {"status": "ok" if r["ok"] else "failed", "ts": C.iso(), "detail": detail[:400]}
        C.write_json(STATE_F(), m)
    else:
        mark("reconcile_staging", "ok" if r["ok"] else "failed", detail, target=target)
    return {"status": "ok" if r["ok"] else "failed", "detail": detail, "failures": [{"ns": c["ns"], "problems": c["problems"]} for c in bad], "missing": r["missing"], "extra": r["extra"]}


# ------------------------------------------------------------------ transactions test (replica set check, run as the real app role)
TXN_JS = r"""
var d = Mongo(process.env.SRC_URI).getDB(process.env.SRC_DB);
var suffix = ObjectId().str;
var a = 'txn_probe_a_' + suffix;
var b = 'txn_probe_b_' + suffix;
var s = d.getMongo().startSession();
var sd = s.getDatabase(process.env.SRC_DB);
var out = {};

try {
  d.createCollection(a);
  d.createCollection(b);

  s.startTransaction({
    readConcern: {level:'snapshot'},
    writeConcern: {w:'majority'}
  });

  sd.getCollection(a).insertOne({_id:1});
  sd.getCollection(b).insertOne({_id:1});
  s.commitTransaction();

  out.commit =
    d.getCollection(a).countDocuments({}) === 1 &&
    d.getCollection(b).countDocuments({}) === 1;

  s.startTransaction();
  sd.getCollection(a).insertOne({_id:2});
  sd.getCollection(b).insertOne({_id:2});
  s.abortTransaction();

  out.abort =
    d.getCollection(a).countDocuments({_id:2}) === 0 &&
    d.getCollection(b).countDocuments({_id:2}) === 0;

  out.ok = out.commit && out.abort;

} finally {
  try { s.abortTransaction(); } catch (e) {}
  try { s.endSession(); } catch (e) {}
  try { d.getCollection(a).drop(); } catch (e) {}
  try { d.getCollection(b).drop(); } catch (e) {}
}

return out;
"""


def txn_test():
    e = mig_env()
    need(e, "STAGING_MONGODB_URI")
    try:
        r = mongosh_env(TXN_JS, {"SRC_URI": e["STAGING_MONGODB_URI"], "SRC_DB": db_name(e["STAGING_MONGODB_URI"])}, 120)
    except Exception as ex:
        return {"status": "failed", "error": str(ex)[:300]}
    return {"status": "ok" if r["ok"] else "failed", **r}


# ------------------------------------------------------------------ 4. staging restore
def stage():
    e = mig_env()
    src_uri, src_db = atlas_source(e, "staging")
    need(e, "STAGING_MONGODB_URI")
    stg_db = db_name(e["STAGING_MONGODB_URI"])
    production_db = prod_db(e)

    if stg_db == production_db or stg_db == src_db:
        mark("stage", "failed", "staging database name matches production or Atlas source")
        return {"status": "failed", "error": "refusing: staging database name must differ from production and Atlas"}

    if M()["steps"].get("audit_staging", {}).get("status") != "ok":
        return {"status": "refused", "error": "Run migrate audit --target staging first."}
    if M()["steps"].get("backup_staging", {}).get("status") != "ok":
        return {"status": "refused", "error": "Run migrate backup --target staging first; a staging Atlas backup must exist."}

    prof, _ = RES.effective_backup_profile()
    t0 = time.time()
    try:
        _stream_copy(src_uri, src_db, e["STAGING_MONGODB_URI"], stg_db, prof, drop=True)
    except Exception as ex:
        mark("stage", "failed", C.redact(str(ex)))
        return {"status": "failed", "error": C.redact(str(ex))[:300]}

    mark("stage", "ok", "Atlas '%s' copied into Community staging database '%s' in %ds." % (src_db, stg_db, time.time() - t0))
    return {"status": "ok", "stagingDb": stg_db, "seconds": int(time.time() - t0), "next": "reconcile staging, connect the staging POS to this database, test it, then plan production migration"}


# ------------------------------------------------------------------ 5. delta (never overwrite newer with older)
DELTA_JS = r"""
var S = Mongo(process.env.SRC_URI).getDB(process.env.SRC_DB), D = Mongo(process.env.DST_URI).getDB(process.env.DST_DB);
var since = new Date(process.env.SINCE), apply = process.env.APPLY === '1', CAP = 200000;
var out = {since: since, apply: apply, collections: [], totals: {inserted:0, replaced:0, same:0, dstNewer:0, conflicts:0, errors:0, noTimestamp:0, truncated:0}};
S.getCollectionInfos({type:'collection'}).map(function(c){return c.name;}).filter(function(n){return n.indexOf('system.')!==0;}).forEach(function(n){
  var sc = S.getCollection(n), dc = D.getCollection(n), f = ['updatedAt','createdAt','timestamp','at'].find(function(k){ var q = {}; q[k] = {$exists:true}; return sc.findOne(q) !== null; }) || null;
  var r = {ns:n, field:f, inserted:0, replaced:0, same:0, dstNewer:0, conflicts:0, errors:0, truncated:0, samples:[]};
  if (!f) { r.noTimestamp = true; r.srcCount = sc.estimatedDocumentCount(); r.dstCount = dc.estimatedDocumentCount(); out.totals.noTimestamp++; out.collections.push(r); return; }
  var q = {}; q[f] = {$gte: since}; var cur = sc.find(q).limit(CAP + 1);
  while (cur.hasNext()) {
    if (r.inserted + r.replaced + r.same + r.dstNewer + r.conflicts + r.errors >= CAP) {
      r.truncated = 1;
      out.totals.truncated++;
      break;
    }
    var doc = cur.next(), o = dc.findOne({_id: doc._id});
    try {
      function stamp(v) {
        if (v instanceof Date) {
          var t = v.getTime();
          return isFinite(t) ? t : null;
        }
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v === 'string' && v.trim()) {
          var parsed = Date.parse(v);
          return isFinite(parsed) ? parsed : null;
        }
        return null;
      }
      if (!o) { if (apply) dc.insertOne(doc); r.inserted++; }
      else if (EJSON.stringify(o) === EJSON.stringify(doc)) r.same++;
      else {
        var dstTime = stamp(o[f]), srcTime = stamp(doc[f]);
        if (dstTime === null || srcTime === null) {
          r.conflicts++;
          if (r.samples.length < 10) r.samples.push(String(doc._id) + ': invalid or unsupported timestamp');
        }
        else if (srcTime > dstTime) {
          if (apply) dc.replaceOne({_id: doc._id}, doc);
          r.replaced++;
        }
        else if (srcTime < dstTime) r.dstNewer++;
        else {
          r.conflicts++;
          if (r.samples.length < 10) r.samples.push(String(doc._id) + ': equal timestamps but different content');
        }
      }
    } catch (e) { r.errors++; if (r.samples.length < 10) r.samples.push(String(doc._id) + ': ' + String(e).slice(0, 80)); } }
  ['inserted','replaced','same','dstNewer','conflicts','errors'].forEach(function(k){ out.totals[k] += r[k]; });
  if (r.inserted || r.replaced || r.conflicts || r.errors || r.dstNewer || r.truncated) out.collections.push(r);
});
return out;
"""


def delta(since_iso=None, apply=False, reverse=False):
    e = mig_env()
    need(e, "ATLAS_URI", "MONGO_ADMIN_URI")
    src_db = e.get("ATLAS_DB") or db_name(e["ATLAS_URI"])
    pdb = prod_db(e)
    m = M()
    since = since_iso or (m["steps"].get("cutover", {}).get("since") if not reverse else m["steps"].get("cutover", {}).get("cutoverAt"))
    if not since:
        return {"status": "refused", "error": "Pass --since <ISO time> (usually shown by the cutover step)."}
    if C.parse_iso(since) is None:
        return {"status": "refused", "error": "bad --since"}
    s_uri, s_db, d_uri, d_db = ((e["MONGO_ADMIN_URI"], pdb, e["ATLAS_URI"], src_db) if reverse else (e["ATLAS_URI"], src_db, e["MONGO_ADMIN_URI"], pdb))
    try:
        r = mongosh_env(DELTA_JS, {"SRC_URI": s_uri, "SRC_DB": s_db, "DST_URI": d_uri, "DST_DB": d_db, "SINCE": since, "APPLY": "1" if apply else "0"}, 3600)
    except Exception as ex:
        return {"status": "failed", "error": str(ex)[:300]}
    t = r["totals"]
    r["status"] = "ok" if not (t["conflicts"] or t["errors"] or t["noTimestamp"] or t["dstNewer"] or t["truncated"]) else "needs-review"
    C.write_json(os.path.join(C.STATE, "migration-delta%s.json" % ("-reverse" if reverse else "")), {"ts": C.iso(), **r})
    if apply and not reverse:
        mark("delta", "ok" if r["status"] == "ok" else "failed", "Delta applied: %d inserted, %d updated, %d conflicts, %d errors." % (t["inserted"], t["replaced"], t["conflicts"], t["errors"]))
    return r


# ------------------------------------------------------------------ process / env helpers for cutover and rollback
def app_user():
    return pwd.getpwuid(os.stat(C.BASE).st_uid).pw_name


def pm2(*args):
    return C.run(["runuser", "-l", app_user(), "-c", "pm2 " + " ".join(shlex.quote(a) for a in args)], 180)


def active_slot():
    try:
        return open(os.path.join(C.BASE, "deployment/state/active_slot")).read().strip()
    except Exception:
        return None


def env_files():
    return [os.path.join(C.BASE, "shared/env", n + ".env") for n in ("blue", "green", "worker")]


def read_uri(path):
    for l in open(path).read().splitlines():
        m = re.match(r"^\s*(?:export\s+)?MONGODB_URI\s*=\s*(.*)$", l)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


def set_uri(path, uri):
    st = os.stat(path)
    lines, done = open(path).read().splitlines(), False
    for i, l in enumerate(lines):
        if re.match(r"^\s*(?:export\s+)?MONGODB_URI\s*=", l):
            lines[i] = "MONGODB_URI=" + uri
            done = True
    if not done:
        lines.append("MONGODB_URI=" + uri)
    tmp = path + ".mig.tmp"
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, path)


def probe(port, path):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=3) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as ex:
        return ex.code, {}
    except Exception:
        return 0, {}


def wait_ready(slots, want_local, secs=90):
    """Every listed slot must answer /health/ready AND /health/db, with the expected database kind (local Community vs Atlas)."""
    t = time.time()
    bad = {}
    while time.time() - t < secs:
        bad = {}
        for s in slots:
            port = {"blue": 5100, "green": 5101}[s]
            c1, _ = probe(port, "/health/ready")
            c2, j = probe(port, "/health/db")
            if c1 != 200 or c2 != 200 or (j.get("database") or {}).get("local") is not want_local:
                bad[s] = (c1, c2, (j.get("database") or {}).get("local"))
        if not bad:
            return True, {}
        time.sleep(3)
    return False, bad


def restart_apps(slots):
    for s in slots:
        service = "sixstar-" + s
        rc, out, err = pm2("restart", service)
        if rc != 0:
            raise RuntimeError(
                "Could not restart %s: %s" %
                (service, C.redact(err or out)[:200])
            )


def flag(on):
    p = os.path.join(C.BASE, "shared/maintenance.flag")
    if on:
        open(p, "a").close()
    else:
        rm(p)


def worker_ready():
    """Require a fresh readiness marker matching the live PM2 worker process."""
    path = os.path.join(C.BASE, "deployment/state/worker.ready")
    try:
        with open(path, encoding="utf-8") as f:
            ready = json.load(f)

        release = ready.get("release")
        pid = int(ready.get("pid", 0))
        jobs = int(ready.get("jobs", 0))
        ts = int(ready.get("ts", 0))
        age_ms = int(time.time() * 1000) - ts

        if not release or pid <= 0 or jobs != 13 or age_ms < 0 or age_ms > 45000:
            return False

        rc, out, err = pm2("jlist")
        if rc != 0:
            return False

        processes = json.loads(out)
        worker = next((x for x in processes if x.get("name") == "sixstar-worker"), None)
        if not worker:
            return False

        env = worker.get("pm2_env") or {}
        if env.get("status") != "online" or env.get("RELEASE_ID") != release:
            return False
        if int(worker.get("pid") or 0) != pid:
            return False

        os.kill(pid, 0)
        return True
    except (OSError, ValueError, TypeError, KeyError, StopIteration, json.JSONDecodeError):
        return False


def worker_stopped():
    """Require PM2 to report the worker stopped with no live process PID."""
    try:
        rc, out, err = pm2("jlist")
        if rc != 0:
            return False

        processes = json.loads(out)
        worker = next(
            (x for x in processes if x.get("name") == "sixstar-worker"),
            None
        )
        if not worker:
            return False

        env = worker.get("pm2_env") or {}
        status = env.get("status")
        pid = int(worker.get("pid") or 0)

        if status not in ("stopped", "errored") or pid > 0:
            return False

        return not os.path.exists(
            os.path.join(C.BASE, "deployment/state/worker.ready")
        )
    except (OSError, ValueError, TypeError, KeyError, StopIteration):
        return False


# ------------------------------------------------------------------ 6. cutover
def preflight_cutover(e):
    probs = []
    m = M()
    for s in ("audit_prod", "backup_prod", "stage", "reconcile_staging"):
        if m["steps"].get(s, {}).get("status") != "ok":
            probs.append("step '%s' has not passed" % s)
    rs = m["steps"].get("reconcile_staging", {})
    if rs.get("ts") and time.time() - (C.parse_iso(rs["ts"]) or 0) > 14 * 86400:
        probs.append("the staging reconciliation is older than 14 days - run stage + reconcile again")
    if active_slot() in (None, "legacy"):
        probs.append("the live API is the legacy process (sixstar-pos), which reads its own .env. Deploy through blue/green first, then cut over (cutover edits blue/green/worker env files only).")
    for p in env_files():
        if not os.path.exists(p):
            probs.append("missing " + p)
    pre = B.preflight()
    if pre:
        probs.append("backups are not configured (%s) - finish the install guide section 4 first" % pre)
    t = txn_test()
    if t.get("status") != "ok":
        probs.append("transaction test failed: %s" % (t.get("error") or t))
    return probs


def services_stopped(names):
    """Require PM2 to report every named service stopped with no live PID."""
    try:
        rc, out, err = pm2("jlist")
        if rc != 0:
            return False

        processes = json.loads(out)
        for name in names:
            proc = next((x for x in processes if x.get("name") == name), None)
            if not proc:
                return False

            env = proc.get("pm2_env") or {}
            status = env.get("status")
            pid = int(proc.get("pid") or 0)

            if status not in ("stopped", "errored") or pid > 0:
                return False

        return True
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return False


def cutover(confirm=None):
    e = mig_env()
    need(e, "ATLAS_URI", "MONGO_ADMIN_URI", "APP_MONGODB_URI")
    if confirm != "CUTOVER":
        return {"status": "refused", "error": 'This switches production to the new database. Re-run with --confirm CUTOVER (off-peak, after announcing a short maintenance window).'}
    lk = C.Lock("migration")
    if not lk.acquire():
        return {"status": "busy"}
    src_db = e.get("ATLAS_DB") or db_name(e["ATLAS_URI"])
    pdb = prod_db(e)
    frozen, saved = False, None
    try:
        probs = preflight_cutover(e)
        if probs:
            return {"status": "refused", "problems": probs}
        # production target must be EMPTY: never overwrite existing (possibly newer) data
        try:
            cnt = mongosh_env("var d = Mongo(process.env.DST_URI).getDB(process.env.DST_DB); return d.getCollectionNames().filter(function(n){return n.indexOf('system.')!==0 && d.getCollection(n).estimatedDocumentCount()>0;}).length;",
                              {"DST_URI": e["MONGO_ADMIN_URI"], "DST_DB": pdb}, 120)
        except Exception as ex:
            return {"status": "refused", "problems": ["cannot inspect the Community production database: %s" % str(ex)[:200]]}
        if cnt:
            return {"status": "refused", "problems": ["Community database '%s' already contains data. Cutover never restores over existing data. Inspect it, and if it is only a test copy drop it manually, then retry." % pdb]}
        prof, _ = RES.effective_backup_profile()
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        saved = os.path.join(MIG_DIR(), "env-" + stamp)
        os.makedirs(saved, mode=0o700, exist_ok=True)
        for p in env_files():
            shutil.copy2(p, os.path.join(saved, os.path.basename(p)))
        slots = ["blue", "green"]
        started = time.time()
        since = C.iso(started - 600)
        C.event("cutover_start", "warning", "Database cutover started. Maintenance mode ON.", notify=True)
        # --- freeze writes
        frozen = True
        flag(True)
        # Stop every production writer before taking the final backup/copy.
        for service in ("sixstar-worker", "sixstar-blue", "sixstar-green"):
            stop_rc, stop_out, stop_err = pm2("stop", service)
            if stop_rc != 0:
                raise RuntimeError(
                    "Could not stop %s: %s" %
                    (service, C.redact(stop_err or stop_out)[:200])
                )

        if not services_stopped(
            ("sixstar-worker", "sixstar-blue", "sixstar-green")
        ) or not worker_stopped():
            raise RuntimeError(
                "Could not verify worker and both API slots stopped; "
                "final backup and database copy aborted."
            )

        time.sleep(5)
        # --- final encrypted Atlas archive (independent recovery copy of the frozen source) + stream into Community
        b = backup("prod")
        if b.get("status") != "ok":
            raise RuntimeError("final Atlas backup failed: %s" % b.get("error"))
        try:
            _stream_copy(e["ATLAS_URI"], src_db, e["MONGO_ADMIN_URI"], pdb, prof, drop=False)
        except Exception:
            mongosh_env("Mongo(process.env.DST_URI).getDB(process.env.DST_DB).dropDatabase(); return true;", {"DST_URI": e["MONGO_ADMIN_URI"], "DST_DB": pdb}, 300)   # only our own partial copy
            raise
        r = reconcile("prod", tol=0.0)
        if r["status"] != "ok":
            mongosh_env("Mongo(process.env.DST_URI).getDB(process.env.DST_DB).dropDatabase(); return true;", {"DST_URI": e["MONGO_ADMIN_URI"], "DST_DB": pdb}, 300)
            raise RuntimeError("reconciliation failed (%s). Production stays on Atlas." % r.get("detail"))
        # --- switch
        for p in env_files():
            set_uri(p, e["APP_MONGODB_URI"])
        restart_apps(slots)
        ok, bad = wait_ready(slots, True)
        if not ok:
            raise RuntimeError("API slots are not ready on the new database: %s" % bad)
        ready_file = os.path.join(C.BASE, "deployment/state/worker.ready")
        rm(ready_file)  # never accept a readiness marker from the previous worker
        rc, out, err = pm2("start", "sixstar-worker")
        if rc != 0:
            raise RuntimeError("Could not start the worker: %s" % C.redact(err or out)[:200])

        worker_ok = False
        for _ in range(40):
            if worker_ready():
                worker_ok = True
                break
            time.sleep(3)
        if not worker_ok:
            raise RuntimeError("Worker did not prove readiness within 120 seconds; maintenance remains enabled until recovery is verified.")
        flag(False)
        cutover_at = C.iso(started)
        mark("cutover", "ok", "Production now runs on MongoDB Community (%d s). Atlas untouched as rollback source." % (time.time() - started), cutoverAt=cutover_at, since=since, envBackup=saved, prodDb=pdb)
        return {"status": "ok", "cutoverAt": cutover_at, "envBackup": saved,
                "delta_status": "not-run",
                "next": ["Test: login, a sale, stock movement, report, M-Pesa callback, SMS",
                         "Run: sixstar-mongoctl backup full && sixstar-mongoctl verify latest",
                         "Keep Atlas for at least 14 days, then `migrate finalize`"]}
    except Exception as ex:
        error = C.redact(str(ex))[:300]
        rb = {"ok": False, "maintenance": "enabled", "worker": "stopped"}

        if frozen:
            # Fail closed: never expose production while recovery is incomplete.
            try:
                flag(True)
                ready_file = os.path.join(C.BASE, "deployment/state/worker.ready")
                rm(ready_file)

                stop_rc, stop_out, stop_err = pm2("stop", "sixstar-worker")
                if stop_rc != 0 or not worker_stopped():
                    rb["error"] = "Could not verify that the worker is stopped; Atlas environment was not restored. " + C.redact(stop_err or stop_out)[:200]
                else:
                    rb = _restore_env(saved, slots=["blue", "green"], verify_local=False)
                    rb["maintenance"] = "enabled"
                    rb["worker"] = "stopped"

                    if rb.get("ok"):
                        rm(ready_file)
                        start_rc, start_out, start_err = pm2("start", "sixstar-worker")
                        if start_rc == 0:
                            worker_ok = False
                            for _ in range(40):
                                if worker_ready():
                                    worker_ok = True
                                    break
                                time.sleep(3)

                            if worker_ok:
                                flag(False)
                                rb["worker"] = "ready"
                                rb["maintenance"] = "cleared"
                                rb["workerReady"] = True
                            else:
                                pm2("stop", "sixstar-worker")
                                rm(ready_file)
                                rb["ok"] = False
                                rb["worker"] = "stopped (readiness not proven)"
                                rb["error"] = "Atlas API settings were restored, but worker readiness failed. Maintenance remains enabled."
                        else:
                            pm2("stop", "sixstar-worker")
                            rm(ready_file)
                            rb["ok"] = False
                            rb["error"] = "Atlas API settings were restored, but worker start failed. Maintenance remains enabled. " + C.redact(start_err or start_out)[:200]
                    else:
                        pm2("stop", "sixstar-worker")
                        rm(ready_file)
                        rb["maintenance"] = "enabled"
                        rb["worker"] = "stop requested"
            except Exception as recovery_error:
                try:
                    flag(True)
                except Exception:
                    pass
                try:
                    pm2("stop", "sixstar-worker")
                    rm(os.path.join(C.BASE, "deployment/state/worker.ready"))
                except Exception:
                    pass
                rb = {
                    "ok": False,
                    "maintenance": "enabled (requested)",
                    "worker": "stop requested",
                    "error": "Recovery procedure raised an error: " + C.redact(str(recovery_error))[:200]
                }

        try:
            C.event(
                "cutover_failed", "critical",
                "Cutover failed. Recovery result: " + str(rb)[:250],
                notify=True
            )
        except Exception:
            pass

        mark("cutover", "failed", error)
        return {"status": "failed", "error": error, "rolledBack": rb}
    finally:
        lk.release()


def _restore_env(saved, slots, verify_local):
    if not saved or not os.path.isdir(saved):
        return {"ok": False, "error": "no env backup folder"}

    targets = env_files()
    prepared = []

    # Validate every source and destination before changing any file.
    for target in targets:
        backup = os.path.join(saved, os.path.basename(target))

        if not os.path.isfile(backup):
            return {
                "ok": False,
                "error": "incomplete environment backup; missing " + os.path.basename(backup),
                "changed": []
            }

        if not os.path.isfile(target):
            return {
                "ok": False,
                "error": "current environment file is missing: " + os.path.basename(target),
                "changed": []
            }

        try:
            uri = read_uri(backup)
        except Exception:
            uri = None

        if not uri or not uri.startswith(("mongodb://", "mongodb+srv://")):
            return {
                "ok": False,
                "error": "backup has no valid MongoDB URI: " + os.path.basename(backup),
                "changed": []
            }

        prepared.append((target, uri))

    changed = []

    # Restore only after all three backups have passed validation.
    for target, uri in prepared:
        try:
            set_uri(target, uri)
            if read_uri(target) != uri:
                return {
                    "ok": False,
                    "error": "URI read-back verification failed: " + os.path.basename(target),
                    "changed": changed
                }
            changed.append(os.path.basename(target))
        except Exception as ex:
            return {
                "ok": False,
                "error": "could not restore " + os.path.basename(target) + ": " + C.redact(str(ex))[:180],
                "changed": changed
            }

    try:
        restart_apps(slots)
        ok, bad = wait_ready(slots, verify_local)
        return {
            "ok": bool(ok),
            "notReady": bad,
            "changed": changed
        }
    except Exception as ex:
        return {
            "ok": False,
            "error": "API restart or readiness verification failed: " + C.redact(str(ex))[:200],
            "changed": changed
        }

def rollback(sync_back=True, confirm=None):
    if confirm != "ROLLBACK":
        return {"status": "refused", "error": "Re-run with --confirm ROLLBACK. Documents created on Community since cutover are copied back to Atlas first (unless --no-sync-back)."}

    lk = C.Lock("migration")
    if not lk.acquire():
        return {"status": "busy"}

    try:
        m = M()
        cut = m["steps"].get("cutover", {})
        saved = cut.get("envBackup")

        if cut.get("status") != "ok" or not saved:
            return {"status": "refused", "error": "No completed cutover is recorded, so there is nothing to roll back."}

        flag(True)
        ready_file = os.path.join(C.BASE, "deployment/state/worker.ready")
        rm(ready_file)

        stop_rc, stop_out, stop_err = pm2("stop", "sixstar-worker")
        if stop_rc != 0 or not worker_stopped():
            return {
                "status": "failed",
                "error": "Could not verify that the worker stopped. Maintenance remains enabled; sync-back and environment restoration were not attempted.",
                "workerStopError": C.redact(stop_err or stop_out)[:200]
            }

        time.sleep(15)
        sync = None

        if sync_back:
            sync = delta(
                since_iso=C.iso(
                    (C.parse_iso(cut["cutoverAt"]) or time.time()) - 300
                ),
                apply=True,
                reverse=True
            )

            if sync.get("status") != "ok":
                return {
                    "status": "failed",
                    "error": "Sync-back to Atlas did not pass verification. Production remains on Community; maintenance stays enabled and the worker stays stopped.",
                    "syncStatus": sync.get("status"),
                    "syncError": sync.get("error"),
                    "syncTotals": sync.get("totals")
                }

        restored = _restore_env(
            saved, ["blue", "green"], verify_local=False
        )

        if not restored.get("ok"):
            return {
                "status": "failed",
                "error": "Atlas environment restoration or API readiness verification failed. Maintenance remains enabled and the worker stays stopped.",
                "ready": restored,
                "syncBack": (sync or {}).get("totals")
            }

        rm(ready_file)
        start_rc, start_out, start_err = pm2("start", "sixstar-worker")

        if start_rc != 0:
            pm2("stop", "sixstar-worker")
            rm(ready_file)
            return {
                "status": "failed",
                "error": "Atlas APIs are ready, but the worker could not be started. Maintenance remains enabled.",
                "workerError": C.redact(start_err or start_out)[:200],
                "ready": restored
            }

        worker_ok = False
        for _ in range(40):
            if worker_ready():
                worker_ok = True
                break
            time.sleep(3)

        if not worker_ok:
            pm2("stop", "sixstar-worker")
            rm(ready_file)
            return {
                "status": "failed",
                "error": "Atlas APIs are ready, but fresh worker readiness was not proven within 120 seconds. Maintenance remains enabled.",
                "ready": restored
            }

        flag(False)
        mark(
            "rollback", "ok",
            "Rolled back to Atlas. Sync-back totals: %s" %
            (json.dumps(sync["totals"]) if sync else "skipped")
        )

        return {
            "status": "ok",
            "syncBack": (sync or {}).get("totals"),
            "ready": restored,
            "workerReady": True,
            "note": "Review %s/migration-delta-reverse.json for conflicts." % C.STATE
        }
    finally:
        lk.release()

def finalize():
    m = M()
    c = m["steps"].get("cutover", {})
    if c.get("status") != "ok":
        return {"status": "refused", "error": "cutover has not completed"}
    age = (time.time() - (C.parse_iso(c["ts"]) or time.time())) / 86400
    if age < 14:
        return {"status": "refused", "error": "Keep Atlas as the rollback source for at least 14 days (%.1f so far)." % age}
    rt = (C.read_json(os.path.join(C.STATE, "restore-tests.json"), {}) or {}).get("restore", {})
    if rt.get("status") != "passed":
        return {"status": "refused", "error": "A restore test has not passed yet. Run `sixstar-mongoctl restore-test` first."}
    mark("finalize", "ok", "Migration finalised after %.0f days. Atlas was NOT deleted by this tool: pause/terminate the Atlas cluster yourself in the Atlas console." % age)
    return {"status": "ok", "note": "Atlas was not touched. Download a final Atlas snapshot in the Atlas console before terminating the cluster."}


def status():
    m = M()
    nxt = next((s for s in STEPS if m["steps"].get(s, {}).get("status") != "ok"), None)
    return {"phase": m.get("phase"), "steps": m["steps"], "next": nxt}
