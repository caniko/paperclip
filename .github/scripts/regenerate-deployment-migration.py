#!/usr/bin/env python3
"""Verify that hosted Drizzle generation leaves journaled migrations unchanged."""
import argparse
import hashlib
import json
import os
from pathlib import Path

MIGRATIONS = Path("packages/db/src/migrations")
ORIGINAL_SHA256 = "ac20d3f6626b23aaf07e7bc7f6502bbcd728a2808d4b4adb56b2116bb30e6412"
JOURNALED_MIGRATIONS = {
    "0505_sweet_titanium_man.sql": ORIGINAL_SHA256,
    "0506_perpetual_manta.sql": "e9bfec1b4c74697c941a0791f50000550ccdf211fda8161aad82bdeaa6e75d79",
    "0507_deployment_environments.sql": "b435bb7c9cea086298a29e8a933f281d8f39e2cb0ca9cde4158151a468ff6ef7",
    "0508_deployment_budget_guard.sql": "7f825c303b1d7d57fd5c4104cd35a747df6f6cae29ab57fac467aad63b872b94",
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
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("needed=true\n")
    prepare_journaled(evidence, source)


def finish(evidence):
    source = json.loads((evidence / "source.json").read_text())
    finish_journaled(evidence, source)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["prepare", "finish"])
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    (prepare if args.phase == "prepare" else finish)(args.evidence)
