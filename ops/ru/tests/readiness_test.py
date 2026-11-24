"""Configuration checks must detect shared storage despite changed credentials."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("readiness", Path(__file__).resolve().parents[1] / "readiness.py")
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class StorageIdentityTests(unittest.TestCase):
    def test_postgres_different_credentials_still_identify_the_same_database(self):
        first = readiness.storage_identity("postgres://main:password@localhost:5432/shared?sslmode=disable")
        second = readiness.storage_identity("postgresql://ru:another@127.0.0.1/shared?sslmode=require")
        self.assertEqual(first, second)

    def test_mysql_different_credentials_and_options_still_identify_the_same_database(self):
        first = readiness.storage_identity("main:password@tcp(localhost:3306)/shared?charset=utf8mb4")
        second = readiness.storage_identity("ru:another@tcp(127.0.0.1)/shared?parseTime=true")
        self.assertEqual(first, second)

    def test_distinct_databases_on_the_same_server_are_distinct(self):
        self.assertNotEqual(readiness.storage_identity("postgres://main@localhost/main"), readiness.storage_identity("postgres://ru@localhost/ru"))

    def test_sqlite_identity_requires_an_absolute_runtime_path(self):
        self.assertIsNone(readiness.storage_identity("local", "relative.db"))
        self.assertEqual(readiness.storage_identity("local", "/srv/shiny/ru/one-api.db?_txlock=immediate"), ("sqlite", "/srv/shiny/ru/one-api.db"))

    def test_redis_credential_changes_do_not_make_a_shared_keyspace_independent(self):
        self.assertEqual(readiness.storage_identity("redis://main:password@localhost:6379/0"), readiness.storage_identity("redis://ru:another@127.0.0.1/0"))
        self.assertNotEqual(readiness.storage_identity("redis://localhost/0"), readiness.storage_identity("redis://localhost/1"))


if __name__ == "__main__":
    unittest.main()
