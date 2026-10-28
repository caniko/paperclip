#!/usr/bin/env python3
"""Hosted source preparation: let Drizzle generate metadata, preserve guards."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

MIGRATIONS = Path("packages/db/src/migrations")
PROVISIONAL = MIGRATIONS / "0295_nostalgic_rhodey.sql"
ORIGINAL_SHA256 = "ac20d3f6626b23aaf07e7bc7f6502bbcd728a2808d4b4adb56b2116bb30e6412"
GUARD_MARKER = b"CREATE FUNCTION paperclip_deployment_guard()"
JOURNALED_MIGRATIONS = {
    "0398_sweet_titanium_man.sql": ORIGINAL_SHA256,
    "0399_perpetual_manta.sql": "e9bfec1b4c74697c941a0791f50000550ccdf211fda8161aad82bdeaa6e75d79",
    "0400_deployment_environments.sql": "b435bb7c9cea086298a29e8a933f281d8f39e2cb0ca9cde4158151a468ff6ef7",
    "0401_deployment_budget_guard.sql": "7f825c303b1d7d57fd5c4104cd35a747df6f6cae29ab57fac467aad63b872b94",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def migration_inputs():
    return {str(path): digest(path.read_bytes()) for path in sorted(MIGRATIONS.rglob("*"))
            if path.is_file() and path.suffix in {".sql", ".json"}}


def prepare_journaled(evidence, source):
    journal = json.loads((MIGRATIONS / "meta/_journal.json").read_text())
    tags = [entry["tag"] for entry in journal["entries"]]
    for name, expected in JOURNALED_MIGRATIONS.items():
        require(tags.count(Path(name).stem) == 1, f"Missing or duplicate journaled migration: {name}")
        require(digest((MIGRATIONS / name).read_bytes()) == expected, f"Executable migration changed: {name}")
    # SQL-only journal entries have no snapshot; use Drizzle's newest existing one.
    snapshots = sorted((MIGRATIONS / "meta").glob("*_snapshot.json"),
                       key=lambda path: int(path.name.split("_", 1)[0]))
    require(snapshots, "Combined schema snapshot is missing")
    tables = json.loads(snapshots[-1].read_text())["tables"]
    require({"public.deployment_resources", "public.adapter_session_affinities"} <= tables.keys(),
            "Combined snapshot lacks deployment resources or executor affinity")
    (evidence / "journaled-inputs.json").write_text(json.dumps(migration_inputs(), indent=2) + "\n")
    (evidence / "generation.json").write_text(json.dumps({
        "schema": "paperclip.deployment-generation.v1", "qualified": False,
        "state": "journaled-migrations-awaiting-noop-generation", "source": source,
    }, indent=2) + "\n")


def finish_journaled(evidence, source):
    before = json.loads((evidence / "journaled-inputs.json").read_text())
    require(migration_inputs() == before, "Drizzle changed the combined journal, SQL or snapshots")
    for name in before:
        path = Path(name)
        target = evidence / "generated" / "packages/db/src/migrations" / path.relative_to(MIGRATIONS)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    (evidence / "generation.json").write_text(json.dumps({
        "schema": "paperclip.deployment-generation.v1", "qualified": False,
        "state": "verified-journaled-migrations", "source": source,
        "generator": "pnpm db:generate", "generation_was_noop": True,
        "executable_sql_sha256": JOURNALED_MIGRATIONS,
        "member_sha256": before,
    }, indent=2) + "\n")


def prepare(evidence):
    require(evidence.resolve().is_relative_to(Path(os.environ["RUNNER_TEMP"]).resolve()),
            "Evidence must stay in the hosted runner temporary directory")
    source = json.loads((evidence / "source.json").read_text())
    require(source.get("initialized") is True and source["tested_source"] == source["head"],
            "Generation needs exact-head source identity")
    needed = PROVISIONAL.is_file()
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("needed=true\n")
    if not needed:
        prepare_journaled(evidence, source)
        return
    original = PROVISIONAL.read_bytes()
    require(digest(original) == ORIGINAL_SHA256, "Original deployment SQL changed")
    require(original.count(GUARD_MARKER) == 1, "Original guard boundary is ambiguous")
    guards = original[original.index(GUARD_MARKER):]
    journal = (MIGRATIONS / "meta/_journal.json").read_bytes()
    require(all(entry["tag"] != PROVISIONAL.stem for entry in json.loads(journal)["entries"]),
            "Provisional migration is journaled; do not replace applied lineage")
    (evidence / "original-deployment-migration.sql").write_bytes(original)
    (evidence / "deployment-guards.sql").write_bytes(guards)
    (evidence / "journal-before.json").write_bytes(journal)
    (evidence / "migration-inputs.json").write_text(json.dumps({
        str(path): digest(path.read_bytes()) for path in sorted(MIGRATIONS.glob("*.sql"))
        if path != PROVISIONAL
    }, indent=2) + "\n")
    # Only this disposable hosted checkout changes. No snapshot or journal is
    # fabricated, and the complete original SQL remains in the artifact.
    PROVISIONAL.unlink()


def finish(evidence):
    source = json.loads((evidence / "source.json").read_text())
    if (evidence / "journaled-inputs.json").is_file():
        finish_journaled(evidence, source)
        return
    before = json.loads((evidence / "journal-before.json").read_text())
    journal_path = MIGRATIONS / "meta/_journal.json"
    after = json.loads(journal_path.read_text())
    require(after["entries"][:-1] == before["entries"]
            and len(after["entries"]) == len(before["entries"]) + 1,
            "Drizzle must preserve the prior journal and add exactly one migration")
    require({key: value for key, value in after.items() if key != "entries"}
            == {key: value for key, value in before.items() if key != "entries"},
            "Drizzle changed journal metadata")
    for name, expected in json.loads((evidence / "migration-inputs.json").read_text()).items():
        require(digest(Path(name).read_bytes()) == expected, f"Existing migration changed: {name}")
    entry = after["entries"][-1]
    require(re.fullmatch(r"\d{4}_[a-z_]+", entry["tag"]), "Invalid generated migration tag")
    sql_path = MIGRATIONS / f"{entry['tag']}.sql"
    generated = sql_path.read_bytes()
    require(len(re.findall(rb'CREATE TABLE\s+"', generated)) == 1
            and b'CREATE TABLE "deployment_resources"' in generated
            and generated.count(b"CREATE UNIQUE INDEX") == 2
            and b'"deployment_resources_identity"' in generated
            and b'"deployment_resources_resource"' in generated
            and not re.search(rb"\b(?:ALTER|DROP)\b", generated),
            "Generated migration contains changes beyond deployment table/indexes")
    (evidence / "drizzle-generated.sql").write_bytes(generated)
    guards = (evidence / "deployment-guards.sql").read_bytes()
    require(GUARD_MARKER not in generated, "Drizzle unexpectedly generated application guards")
    result = generated.rstrip() + b"\n--> statement-breakpoint\n" + guards
    sql_path.write_bytes(result)
    require(result[result.index(GUARD_MARKER):] == guards, "Custom guard bytes changed")
    snapshot_path = MIGRATIONS / "meta" / f"{int(entry['idx']):04d}_snapshot.json"
    snapshot = json.loads(snapshot_path.read_text())
    require("public.deployment_resources" in snapshot["tables"], "Snapshot lacks deployment resources")
    subprocess.run(["git", "add", "-N", str(sql_path), str(snapshot_path)], check=True)
    patch = subprocess.check_output(["git", "diff", "--binary", "--", str(MIGRATIONS)])
    (evidence / "deployment-migration.patch").write_bytes(patch)
    for path in [sql_path, journal_path, *sorted((MIGRATIONS / "meta").glob("*_snapshot.json"))]:
        target = evidence / "generated" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    receipt = {
        "schema": "paperclip.deployment-generation.v1", "qualified": False,
        "state": "generated-candidate", "source": source,
        "original_sql_sha256": ORIGINAL_SHA256, "custom_guards_sha256": digest(guards),
        "generated_sql_sha256": digest(generated), "result_sql_sha256": digest(result),
        "journal_sha256": digest(journal_path.read_bytes()), "snapshot_sha256": digest(snapshot_path.read_bytes()),
        "patch_sha256": digest(patch), "migration": str(sql_path), "snapshot": str(snapshot_path),
        "generator": "pnpm db:generate", "custom_guards_byte_identical": True,
    }
    (evidence / "generation.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["prepare", "finish"])
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    (prepare if args.phase == "prepare" else finish)(args.evidence)
