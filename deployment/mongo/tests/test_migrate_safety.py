from pathlib import Path
import ast
import json
import os
import re
import tempfile
import types
import unittest

SOURCE = Path("deployment/mongo/lib/sixstar_mongo/migrate.py")
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))

def get_function(name, namespace):
    if name == "prod_db" and "db_name" not in namespace:
        get_function("db_name", namespace)
    node = next(
        n for n in TREE.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        and n.name == name
    )
    module = ast.Module(body=[node], type_ignores=[])
    exec(compile(module, str(SOURCE), "exec"), namespace)
    return namespace[name]

class MigrationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.C = types.SimpleNamespace(BASE=self.tmp.name)
        self.ns = {
            "os": os,
            "json": json,
            "re": re,
            "C": self.C,
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_db_name_extracts_database(self):
        fn = get_function("db_name", self.ns)
        self.assertEqual(fn("mongodb://localhost:27017/sixstar"), "sixstar")
        self.assertEqual(fn("mongodb+srv://user:pass@host/sixstar?retryWrites=true"), "sixstar")
        self.assertEqual(fn("mongodb://localhost:27017/"), "test")

    def test_prod_db_uses_explicit_database_first(self):
        fn = get_function("prod_db", self.ns)
        self.assertEqual(fn({
            "PROD_DB": "production",
            "APP_MONGODB_URI": "mongodb://localhost/app"
        }), "production")

    def test_prod_db_uses_app_uri_when_no_explicit_database(self):
        fn = get_function("prod_db", self.ns)
        self.assertEqual(fn({
            "APP_MONGODB_URI": "mongodb://localhost/app"
        }), "app")

    def test_need_rejects_missing_environment_values(self):
        fn = get_function("need", self.ns)
        with self.assertRaisesRegex(RuntimeError, "ATLAS_URI"):
            fn({"MONGO_ADMIN_URI": "configured"}, "ATLAS_URI", "MONGO_ADMIN_URI")

    def test_staging_atlas_source_requires_staging_uri(self):
        get_function("need", self.ns)
        get_function("db_name", self.ns)
        fn = get_function("atlas_source", self.ns)
        with self.assertRaisesRegex(RuntimeError, "STAGING_ATLAS_URI"):
            fn({"ATLAS_URI": "mongodb+srv://prod.example.net/production"}, "staging")

    def test_staging_atlas_source_uses_staging_uri(self):
        get_function("need", self.ns)
        get_function("db_name", self.ns)
        fn = get_function("atlas_source", self.ns)
        uri, db = fn({
            "ATLAS_URI": "mongodb+srv://prod.example.net/production",
            "STAGING_ATLAS_URI": "mongodb+srv://stage.example.net/staging"
        }, "staging")
        self.assertEqual(uri, "mongodb+srv://stage.example.net/staging")
        self.assertEqual(db, "staging")

    def test_production_atlas_source_keeps_atlas_uri(self):
        get_function("need", self.ns)
        get_function("db_name", self.ns)
        fn = get_function("atlas_source", self.ns)
        uri, db = fn({
            "ATLAS_URI": "mongodb+srv://prod.example.net/default",
            "ATLAS_DB": "sixstar_prod",
            "STAGING_ATLAS_URI": "mongodb+srv://stage.example.net/staging"
        }, "prod")
        self.assertEqual(uri, "mongodb+srv://prod.example.net/default")
        self.assertEqual(db, "sixstar_prod")

    def test_services_stopped_accepts_all_stopped_processes(self):
        processes = [
            {"name": "sixstar-blue", "pid": 0, "pm2_env": {"status": "stopped"}},
            {"name": "sixstar-green", "pid": 0, "pm2_env": {"status": "errored"}},
        ]
        self.ns["pm2"] = lambda *args: (0, json.dumps(processes), "")
        fn = get_function("services_stopped", self.ns)
        self.assertTrue(fn(["sixstar-blue", "sixstar-green"]))

    def test_services_stopped_rejects_running_process(self):
        processes = [
            {"name": "sixstar-blue", "pid": 123, "pm2_env": {"status": "online"}},
        ]
        self.ns["pm2"] = lambda *args: (0, json.dumps(processes), "")
        fn = get_function("services_stopped", self.ns)
        self.assertFalse(fn(["sixstar-blue"]))

    def test_services_stopped_rejects_missing_process(self):
        self.ns["pm2"] = lambda *args: (0, "[]", "")
        fn = get_function("services_stopped", self.ns)
        self.assertFalse(fn(["sixstar-worker"]))

    def test_services_stopped_rejects_pm2_failure(self):
        self.ns["pm2"] = lambda *args: (1, "", "PM2 error")
        fn = get_function("services_stopped", self.ns)
        self.assertFalse(fn(["sixstar-worker"]))

    def test_worker_stopped_requires_stopped_process_and_no_ready_flag(self):
        processes = [
            {"name": "sixstar-worker", "pid": 0, "pm2_env": {"status": "stopped"}},
        ]
        self.ns["pm2"] = lambda *args: (0, json.dumps(processes), "")
        fn = get_function("worker_stopped", self.ns)
        self.assertTrue(fn())

    def test_worker_stopped_rejects_existing_ready_flag(self):
        ready = Path(self.tmp.name) / "deployment/state/worker.ready"
        ready.parent.mkdir(parents=True)
        ready.write_text("ready")
        processes = [
            {"name": "sixstar-worker", "pid": 0, "pm2_env": {"status": "stopped"}},
        ]
        self.ns["pm2"] = lambda *args: (0, json.dumps(processes), "")
        fn = get_function("worker_stopped", self.ns)
        self.assertFalse(fn())

    def test_cutover_contains_stop_verification_and_no_delta_call(self):
        node = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "cutover")
        calls = {
            n.func.id for n in ast.walk(node)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        }
        self.assertIn("services_stopped", calls)
        self.assertIn("worker_stopped", calls)
        self.assertNotIn("delta", calls)

    def test_rollback_contains_worker_stop_verification(self):
        node = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "rollback")
        calls = {
            n.func.id for n in ast.walk(node)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        }
        self.assertIn("worker_stopped", calls)

if __name__ == "__main__":
    unittest.main(verbosity=2)
