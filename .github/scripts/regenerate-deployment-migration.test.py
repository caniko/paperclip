#!/usr/bin/env python3
"""Protect the hosted generator's immutable, already-journaled source path."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("generation", Path(__file__).with_name("regenerate-deployment-migration.py"))
generation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generation)


class JournaledGenerationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.migrations = self.root / "migrations"
        shutil.copytree(generation.MIGRATIONS, self.migrations)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        (self.evidence / "source.json").write_text(json.dumps({
            "initialized": True, "head": "fixture-head", "tested_source": "fixture-head",
        }))
        for replacement in [
            patch.object(generation, "MIGRATIONS", self.migrations),
            patch.object(generation, "PROVISIONAL", self.migrations / "0295_nostalgic_rhodey.sql"),
            patch.dict(os.environ, {"RUNNER_TEMP": str(self.root), "GITHUB_OUTPUT": str(self.root / "outputs")}),
        ]:
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_accepts_only_noop_generation_of_journaled_sql(self):
        generation.prepare(self.evidence)
        generation.finish(self.evidence)
        receipt = json.loads((self.evidence / "generation.json").read_text())
        self.assertEqual(receipt["state"], "verified-journaled-migrations")
        self.assertTrue(receipt["generation_was_noop"])
        self.assertFalse(receipt["qualified"])

    def test_accepts_sql_only_tail_without_inventing_a_snapshot(self):
        journal_path = self.migrations / "meta/_journal.json"
        journal = json.loads(journal_path.read_text())
        previous = journal["entries"][-1]
        index = previous["idx"] + 1
        tag = f"{index:04d}_sql_only_fixture"
        journal["entries"].append({**previous, "idx": index, "when": previous["when"] + 1, "tag": tag})
        journal_path.write_text(json.dumps(journal))
        (self.migrations / f"{tag}.sql").write_text("-- SQL-only fixture; no schema change.\n")
        before = generation.migration_inputs()
        generation.prepare(self.evidence)
        generation.finish(self.evidence)
        self.assertEqual(generation.migration_inputs(), before)
        self.assertFalse((self.migrations / "meta" / f"{index:04d}_snapshot.json").exists())

    def test_rejects_modified_original_guard(self):
        sql = self.migrations / "0355_sweet_titanium_man.sql"
        sql.write_bytes(sql.read_bytes().replace(b"BEFORE UPDATE OR DELETE", b"AFTER UPDATE OR DELETE", 1))
        with self.assertRaisesRegex(RuntimeError, "Executable migration changed"):
            generation.prepare(self.evidence)

    def test_rejects_generated_journal_mutation(self):
        generation.prepare(self.evidence)
        journal = self.migrations / "meta/_journal.json"
        journal.write_bytes(journal.read_bytes() + b"\n")
        with self.assertRaisesRegex(RuntimeError, "Drizzle changed the combined"):
            generation.finish(self.evidence)


if __name__ == "__main__":
    unittest.main()
