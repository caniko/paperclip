#!/usr/bin/env python3
"""Exact-head hosted qualification receipts and provider-retention readback."""
import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

MIN_RETENTION_SECONDS = 2592000
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ORIGINAL_RED = {"artifact_id": 12146584669, "run_id": 39157504264,
                "head": "9192d66579850b36cf10abd651b41804cfa75447",
                "archive_sha256": "9a095663bf10d8dc1cee82888dfcb37eac059f61c750a08e00687d3193833f3d",
                "fixture_sha256": "c6d9ba1a82820be8eff64cc6dc9658d042fe8e9cd8a3091f0c4126e910f1ff0e"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def environment_policy():
    return json.loads((REPOSITORY_ROOT / ".github/qualification/coverage-environments.json").read_text())


def defer_environment_case(case, policy):
    require(policy["all_declared_cases_required"] is True, "Environment deferrals cannot waive declared cases")
    match = re.fullmatch(r"(.+) \[vitest:([^\]]+)\]", case.get("name", ""), re.DOTALL)
    require(match is not None, "Deferred case is missing its framework identity")
    name, identity = match.groups()
    file = case.get("classname", "")
    rules = [rule for rule in policy["rules"]
             if rule["file"] == file and rule["name_contains"] in name]
    require(rules, f"Mandatory test skipped without a source-backed environment: {file}: {name}")
    source_path = REPOSITORY_ROOT / file
    require(source_path.resolve().is_relative_to(REPOSITORY_ROOT.resolve()), "Deferred source escapes checkout")
    source = source_path.read_text()
    digest = sha256(source_path)
    for rule in rules:
        require(rule["source_sha256"] == digest and rule["anchor"] in source,
                f"Deferred source mapping drifted: {file}")
        require(rule["environment"] in policy["environments"] and rule["environment"] != "default-hosted",
                "Deferred case must execute in a declared non-default environment")
    return {"file": file, "name": name, "id": identity, "source_sha256": digest,
            "environments": sorted({rule["environment"] for rule in rules}),
            "required": True, "execution_evidence": False}


def api(path):
    request = urllib.request.Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/{path}",
        headers={"Authorization": f"Bearer {os.environ['GH_TOKEN']}",
                 "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def event_identity():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    require(os.environ["GITHUB_EVENT_NAME"] == "pull_request", "Qualification requires a PR event")
    pr = event["pull_request"]
    return {"repository": os.environ["GITHUB_REPOSITORY"], "pr": pr["number"], "head": pr["head"]["sha"],
            "base": pr["base"]["sha"], "workflow_ref": os.environ["GITHUB_WORKFLOW_REF"],
            "workflow_sha": os.environ["GITHUB_WORKFLOW_SHA"], "run_id": int(os.environ["GITHUB_RUN_ID"]),
            "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"])}


def identity(source):
    require(source["run_attempt"] == 1, "Retries cannot qualify; publish a source successor")
    live = api(f"pulls/{source['pr']}")
    source["observed_pr"] = {"head": live["head"]["sha"], "base": live["base"]["sha"]}
    require(live["head"]["sha"] == source["head"], "PR head advanced; evidence is historical")
    require(live["base"]["sha"] == source["base"], "PR base advanced; evidence is historical")
    return source


def harness_identity():
    paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "HEAD", "--",
                                     ".github", "scripts/qualification-*"], cwd=REPOSITORY_ROOT, text=True).splitlines()
    subprocess.check_output(["git", "diff", "--exit-code", "HEAD", "--", *paths], cwd=REPOSITORY_ROOT)
    files = {path: sha256(REPOSITORY_ROOT / path) for path in sorted(paths)}
    require(".github/qualification/rollout-exceptions.json" in files, "The exception policy must be committed")
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"harness_sha256": digest, "harness_files": files,
            "policy_sha256": files[".github/qualification/coverage-environments.json"],
            "exception_policy_sha256": files[".github/qualification/rollout-exceptions.json"]}


def initialize(directory):
    directory.mkdir(parents=True, exist_ok=True)
    source = {"initialized": False, "platform": platform.platform(), "machine": platform.machine(),
              "receipt_tool_sha256": sha256(__file__),
              "runner_environment": os.environ.get("RUNNER_ENVIRONMENT"),
              "retention_days": os.environ.get("GITHUB_RETENTION_DAYS")}
    try:
        source["event_sha256"] = sha256(os.environ["GITHUB_EVENT_PATH"])
        source.update(event_identity())
        source["tested_source"] = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        source["locks"] = {str(path): sha256(path) for path in
                           (Path("pnpm-lock.yaml"), Path("flake.lock"), Path("Cargo.lock"),
                            Path("uv.lock"), Path("packages/paperclip-runner/runner/Cargo.lock")) if path.is_file()}
        require(source["runner_environment"] == "github-hosted", "Only GitHub-hosted runners qualify")
        require(int(os.environ["GITHUB_RETENTION_DAYS"]) >= 31, "Repository/organization retention must allow 31 days")
        identity(source)
        require(source["tested_source"] == source["head"], "Checkout is not the exact PR head")
        source["tree"] = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip()
        source.update(harness_identity())
        source["initialized"] = True
    except Exception as error:
        source["initialization_error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        (directory / "source.json").write_text(json.dumps(source, indent=2) + "\n")


def seal(directory, outcome, strict_reports, defer_environment_skips=False):
    source = json.loads((directory / "source.json").read_text())
    reports = []
    rejected = []
    deferrals = []
    if source.get("initialized") is not True:
        rejected.append(source.get("initialization_error", "Source initialization did not complete"))
    if source.get("harness_files"):
        for name, digest in source["harness_files"].items():
            if not (REPOSITORY_ROOT / name).is_file() or sha256(REPOSITORY_ROOT / name) != digest:
                rejected.append(f"Qualification harness changed during execution: {name}")
        try:
            subprocess.check_output(["git", "diff", "--exit-code", "HEAD", "--"], cwd=REPOSITORY_ROOT)
        except subprocess.CalledProcessError:
            rejected.append("Tracked source changed during execution")
    for path in sorted(directory.rglob("*.xml")):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as error:
            rejected.append(f"Invalid JUnit report: {path}: {error}")
            continue
        cases = root.findall(".//testcase")
        if not cases:
            rejected.append(f"Empty JUnit report: {path}")
        identities = [(case.get("classname"), case.get("name")) for case in cases]
        failures = root.findall(".//failure") + root.findall(".//error")
        skipped = root.findall(".//skipped")
        retried = [node for node in root.iter() if "retry" in node.tag.lower() or "flaky" in node.tag.lower()]
        if outcome == "success":
            if len(identities) != len(set(identities)):
                rejected.append(f"Duplicate/retried JUnit cases: {path}")
            if failures or retried:
                rejected.append(f"Failed or retried test: {path}")
            if strict_reports and skipped:
                if not defer_environment_skips:
                    rejected.append(f"Mandatory test skipped: {path}")
                else:
                    try:
                        policy = environment_policy()
                        deferrals.extend(defer_environment_case(case, policy) for case in cases
                                         if case.find("skipped") is not None)
                    except (RuntimeError, KeyError, OSError) as error:
                        rejected.append(str(error))
        reports.append({"path": str(path.relative_to(directory)), "cases": len(cases),
                        "failures": len(failures), "skipped": len(skipped), "retries": len(retried)})
    if strict_reports:
        if not reports:
            rejected.append("Mandatory JUnit evidence is missing")
    receipt = {"schema": "hosted-qualification.v1", **source, "outcome": outcome,
                 "qualified": False, "reports": reports, "rejected": rejected,
                "environment_deferrals": deferrals,
               "members": {str(path.relative_to(directory)): sha256(path)
                            for path in sorted(directory.rglob("*")) if path.is_file() and path != directory / "receipt.json"}}
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if outcome in ("success", "expected-red"):
        require(not rejected, "; ".join(rejected))


def expected_red(directory):
    root = ET.parse(directory / "regression.xml").getroot()
    cases = root.findall(".//testcase")
    require(cases and not root.findall(".//skipped") and not root.findall(".//error"),
            "Expected RED requires completed assertion failures, without errors or skips")
    failed = [case.get("name", "") for case in cases if case.find("failure") is not None]
    oracles = ["binds a delayed ID-less parent poll", "rejects a delayed parent SSE",
               "holds live and recovery ownership", "stops and settles before returning"]
    require(all(any(oracle in name for name in failed) for oracle in oracles),
            f"Missing baseline regression failures: {failed}")
    source_path = directory / "source.json"
    source = json.loads(source_path.read_text())
    source.update({"baseline": "f6451f242d5cbb803e3c265e90f05b642e573203",
                   "regression_fixture_sha256": sha256("packages/adapters/hermes/src/gateway/server/lineage-observation.test.ts"),
                   "expected_assertion_failures": failed})
    source_path.write_text(json.dumps(source, indent=2) + "\n")
    seal(directory, "expected-red", True)


def verify_original_red(raw, metadata, pinned=ORIGINAL_RED):
    require(metadata["id"] == pinned["artifact_id"] and not metadata["expired"], "Original RED artifact is unavailable")
    require(metadata["workflow_run"]["id"] == pinned["run_id"]
            and metadata["workflow_run"]["head_sha"] == pinned["head"], "Original RED producer changed")
    digest = hashlib.sha256(raw).hexdigest()
    require(digest == pinned["archive_sha256"] and metadata["digest"] == "sha256:" + digest,
            "Original RED archive digest mismatch")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        require(len(archive.namelist()) == len(set(archive.namelist())), "Duplicate original RED member")
        receipt = json.loads(archive.read("receipt.json"))
        for name, expected in receipt["members"].items():
            require(hashlib.sha256(archive.read(name)).hexdigest() == expected, f"Original RED member mismatch: {name}")
        require(receipt["head"] == pinned["head"] and receipt["run_id"] == pinned["run_id"]
                and receipt["run_attempt"] == 1 and receipt["runner_environment"] == "github-hosted",
                "Original RED execution identity changed")
        require(receipt["baseline"] == "f6451f242d5cbb803e3c265e90f05b642e573203"
                and receipt["regression_fixture_sha256"] == pinned["fixture_sha256"], "Original RED fixture changed")
        require(receipt["outcome"] == "expected-red" and receipt["qualified"] is False and not receipt["rejected"],
                "Original RED receipt is not valid regression evidence")
        root = ET.fromstring(archive.read("regression.xml"))
        cases = root.findall(".//testcase")
        failures = root.findall(".//failure")
        require(len(cases) == 23 and len(failures) == 20 and not root.findall(".//skipped")
                and not root.findall(".//error"), "Original RED assertion inventory changed")
    return {"original": pinned, "original_cases": len(cases), "original_assertion_failures": len(failures),
            "execution_credit": False, "historical_reference": True, "archive_sha256": digest}


def retain_original_red(directory):
    require(os.environ["GITHUB_REPOSITORY"] == "caniko/paperclip", "Original RED belongs to caniko/paperclip")
    fixture = REPOSITORY_ROOT / "packages/adapters/hermes/src/gateway/server/lineage-observation.test.ts"
    require(sha256(fixture) == ORIGINAL_RED["fixture_sha256"], "Changed regression fixture needs a distinct evidence disposition")
    metadata = api(f"actions/artifacts/{ORIGINAL_RED['artifact_id']}")
    raw = subprocess.check_output(["gh", "api", f"repos/caniko/paperclip/actions/artifacts/{ORIGINAL_RED['artifact_id']}/zip"])
    reference = verify_original_red(raw, metadata)
    (directory / "original-red.zip").write_bytes(raw)
    (directory / "original-red-provider.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (directory / "original-red-reference.json").write_text(json.dumps(reference, indent=2) + "\n")
    seal(directory, "success", False)


def verify_provider_archive(raw, metadata, expected, run_id, now, strict_receipt=True):
    """Verify downloaded provider bytes; local/self-reported digests are insufficient."""
    require(not metadata["expired"], "Provider artifact has expired")
    require(metadata["digest"] == "sha256:" + hashlib.sha256(raw).hexdigest(), "Provider archive SHA-256 differs")
    require(metadata["workflow_run"]["id"] == run_id
            and metadata["workflow_run"]["head_sha"] == expected["head"], "Provider artifact producer differs")
    created = dt.datetime.fromisoformat(metadata["created_at"].replace("Z", "+00:00"))
    expiry = dt.datetime.fromisoformat(metadata["expires_at"].replace("Z", "+00:00"))
    require((expiry - created).total_seconds() >= MIN_RETENTION_SECONDS
            and (expiry - now).total_seconds() >= MIN_RETENTION_SECONDS, "Insufficient actual remaining provider retention")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Duplicate provider archive member")
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in info.filename
                    and str(path) == info.filename.rstrip("/")
                    and not stat.S_ISLNK(info.external_attr >> 16), "Unsafe provider archive member")
        members = {info.filename: archive.read(info) for info in archive.infolist() if not info.is_dir()}
    if not strict_receipt:
        return members, None
    require("receipt.json" in members, "Provider archive lacks a sealed execution receipt")
    receipt = json.loads(members["receipt.json"])
    for field in ["repository", "head", "base", "tree", "harness_sha256", "policy_sha256", "exception_policy_sha256"]:
        require(receipt.get(field) == expected[field], f"Execution {field} differs")
    require(receipt["pr"] == expected["pull_request"] and receipt["tested_source"] == expected["head"], "Execution PR/source differs")
    require(receipt["run_id"] == run_id and receipt["run_attempt"] == 1
            and receipt["runner_environment"] == "github-hosted", "Execution provider/attempt differs")
    require(receipt["initialized"] is True and receipt["outcome"] == "success"
            and receipt["qualified"] is False and not receipt["rejected"], "Execution receipt contains a refusal or failure")
    require(set(receipt["members"]) == set(members) - {"receipt.json"}, "Provider archive has missing or unbound members")
    for name, digest in receipt["members"].items():
        require(hashlib.sha256(members[name]).hexdigest() == digest, f"Provider archive member SHA-256 differs: {name}")
    return members, receipt


def observe_rollout(request_path, directory):
    """Observe original GitHub producers, then decide the source/environment union."""
    directory.mkdir(parents=True, exist_ok=False)
    request = json.loads(request_path.read_bytes())
    def write(name, value):
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(value if isinstance(value, bytes) else (json.dumps(value, indent=2) + "\n").encode())
    write("request.json", request)
    observed = {"qualified": False, "producer_acceptance_qualified": False, "rejected": []}
    try:
        require(request["repository"] == "caniko/paperclip" and request["pull_request"] == 5, "Unexpected rollout repository/PR")
        require(os.environ["GITHUB_REPOSITORY"] == request["repository"], "Provider API repository differs")
        require(subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == request["head"], "Observer checkout differs from the frozen head")
        expected = {key: request[key] for key in ["repository", "pull_request", "head", "base", "tree"]}
        require(subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip() == expected["tree"], "Observer tree differs")
        subprocess.check_output(["git", "diff", "--exit-code", "HEAD", "--"], cwd=REPOSITORY_ROOT)
        harness = harness_identity()
        expected.update({key: value for key, value in harness.items() if key != "harness_files"})
        write("expected-source.json", expected)
        def live_identity(label):
            live = api("pulls/5")
            write(f"{label}-pr.json", live)
            require(live["head"]["sha"] == expected["head"] and live["base"]["sha"] == expected["base"], "Frozen PR head/base advanced")
        live_identity("initial")
        policy = environment_policy()
        exceptions = json.loads((REPOSITORY_ROOT / ".github/qualification/rollout-exceptions.json").read_bytes())
        workflows = {"source": "source-qualification.yml", "coverage": "qualification-coverage.yml",
                     "environments": "qualification-environments.yml", "claude": "qualification-live-claude.yml"}
        require(set(request["runs"]) == set(workflows), "Every original coverage producer must be selected explicitly")
        require(len(set(request["runs"].values())) == len(workflows), "A producer was selected more than once")
        archives = {}
        bindings = []
        now = dt.datetime.now(dt.timezone.utc)
        def download(metadata, head, run_id, strict, target):
            raw = subprocess.check_output(["gh", "api", f"repos/{expected['repository']}/actions/artifacts/{metadata['id']}/zip"])
            write(f"{target}/artifact.zip", raw)
            write(f"{target}/provider.json", metadata)
            members, receipt = verify_provider_archive(raw, metadata, {**expected, "head": head}, run_id, now, strict)
            hashes = {name: hashlib.sha256(value).hexdigest() for name, value in members.items()}
            write(f"{target}/members.json", hashes)
            bindings.append({"artifact_id": metadata["id"], "run_id": run_id, "head": head,
                             "archive_sha256": hashlib.sha256(raw).hexdigest(), "members": hashes,
                             "remaining_retention_seconds": (dt.datetime.fromisoformat(metadata["expires_at"].replace("Z", "+00:00")) - now).total_seconds()})
            return members, receipt
        for kind, workflow in workflows.items():
            run_id = request["runs"][kind]
            run = api(f"actions/runs/{run_id}")
            attempt = api(f"actions/runs/{run_id}/attempts/1")
            write(f"{kind}/run.json", run)
            write(f"{kind}/attempt-1.json", attempt)
            for original in [run, attempt]:
                require(original["id"] == run_id and original["run_attempt"] == 1
                        and original["status"] == "completed" and original["conclusion"] == "success", "Original producer is not terminal attempt-1 GREEN")
                require(original["event"] == "pull_request" and original["head_sha"] == expected["head"]
                        and original["path"] == f".github/workflows/{workflow}", "Producer workflow/head differs")
                require(any(pr["number"] == 5 and pr["head"]["sha"] == expected["head"]
                            and pr["base"]["sha"] == expected["base"] for pr in original["pull_requests"]), "Producer PR/base differs")
            jobs, artifacts_list = [], []
            for endpoint, key, destination in [(f"actions/runs/{run_id}/attempts/1/jobs", "jobs", jobs),
                                                (f"actions/runs/{run_id}/artifacts", "artifacts", artifacts_list)]:
                page = 1
                while True:
                    response = api(f"{endpoint}?per_page=100&page={page}")
                    write(f"{kind}/{key}-{page}.json", response)
                    destination.extend(response[key])
                    if len(response[key]) < 100:
                        break
                    page += 1
            require(jobs and len({job["id"] for job in jobs}) == len(jobs), "Original jobs are missing or duplicated")
            require(all(job["status"] == "completed" and job["conclusion"] == "success"
                        and job["run_attempt"] == 1 and "self-hosted" not in job["labels"]
                        and job["runner_group_name"] == "GitHub Actions" for job in jobs), "A mandatory original job did not pass on GitHub-hosted attempt 1")
            logs = subprocess.check_output(["gh", "api", f"repos/{expected['repository']}/actions/runs/{run_id}/attempts/1/logs"])
            write(f"{kind}/original-logs.zip", logs)
            with zipfile.ZipFile(io.BytesIO(logs)) as log_archive:
                require(log_archive.namelist() and log_archive.testzip() is None, "Original producer logs are empty or corrupt")
            write(f"{kind}/original-logs-sha256.json", {"sha256": hashlib.sha256(logs).hexdigest()})
            names = [artifact["name"] for artifact in artifacts_list]
            require(len(names) == len(set(names)), "Provider artifact names are ambiguous")
            archives[kind] = {}
            for artifact in artifacts_list:
                strict = artifact["name"].startswith(("source-proof-", "required-profile-", "complete-coverage-map-", "live-claude-")) \
                    and not artifact["name"].startswith("live-claude-retention-")
                archives[kind][artifact["name"]] = download(artifact, expected["head"], run_id, strict, f"{kind}/{artifact['id']}")
        suffix = f"-{expected['head']}-1"
        def selected(kind, name):
            require(name + suffix in archives[kind], f"Missing mandatory producer artifact: {name}")
            return archives[kind][name + suffix]
        roster_members, _ = selected("coverage", "complete-coverage-map")
        roster = json.loads(roster_members["coverage-map.json"])
        def reports(members, receipt, producer_scope, deferrals=False):
            results = []
            for name, raw in members.items():
                if not name.endswith(".xml"):
                    continue
                root = ET.fromstring(raw)
                cases = root.findall(".//testcase")
                require(cases and not root.findall(".//failure") and not root.findall(".//error")
                        and not any("retry" in node.tag.lower() or "flaky" in node.tag.lower() for node in root.iter()), "Raw execution report failed, retried or is empty")
                seen = set()
                for case in cases:
                    key = (case.get("classname"), case.get("name"))
                    require(key not in seen, "Raw execution report repeats an identity")
                    seen.add(key)
                    if case.find("skipped") is not None:
                        require(deferrals, "A mandatory raw case skipped")
                        deferred = defer_environment_case(case, policy)
                        require(deferred in receipt["environment_deferrals"], "Raw skip lacks its bound source/environment deferral")
                        continue
                    match = re.fullmatch(r"(.+) \[vitest:([^\]]+)\]", case.get("name", ""), re.DOTALL)
                    if match:
                        results.append({"file": case.get("classname"), "name": match[1], "id": match[2],
                                        "producer_scope": f"{producer_scope}/{name}", "outcome": "passed",
                                        "retryCount": 0, "repeatCount": 0, "run_attempt": 1,
                                        "runner_environment": "github-hosted", "evidence_verified": True, **expected})
            return results
        source_workflow = (REPOSITORY_ROOT / ".github/workflows/source-qualification.yml").read_text()
        lanes = re.findall(r"^          - lane: ([\w-]+)$", source_workflow, re.MULTILINE)
        source_results = []
        for lane in lanes:
            members, receipt = selected("source", f"source-proof-{lane}")
            source_results.extend(reports(members, receipt, f"source/{lane}", lane.startswith("tests-")))
        original_red, _ = selected("source", "source-proof-expected-red")
        verify_original_red(original_red["original-red.zip"], json.loads(original_red["original-red-provider.json"]))
        environment_workflow = (REPOSITORY_ROOT / ".github/workflows/qualification-environments.yml").read_text()
        profiles = re.findall(r"^          - profile: ([\w-]+)$", environment_workflow, re.MULTILINE)
        profile_data = []
        for profile in profiles:
            members, receipt = selected("environments", f"required-profile-{profile}")
            strict_results = reports(members, receipt, f"profile/{profile}")
            profile_data.append({"profile": profile, "source": json.loads(members["profile-source.json"]),
                                 "selection": json.loads(members["profile-selection.json"]),
                                 "results": json.loads(members["profile-raw-results.json"]), "strict_results": strict_results})
        claude_members, claude_receipt = selected("claude", "live-claude")
        claude_results = reports(claude_members, claude_receipt, "live-claude")
        original = exceptions["original_inventory"]
        metadata = api(f"actions/artifacts/{original['artifact_id']}")
        require(metadata["digest"] == "sha256:" + original["archive_sha256"], "Original blocker archive changed")
        blocker_members, _ = download(metadata, original["head"], original["run_id"], False, "original-blockers")
        require(hashlib.sha256(blocker_members[original["member"]]).hexdigest() == original["member_sha256"], "Original blocker member changed")
        blocker_roster = json.loads(blocker_members[original["member"]])
        waived = {exception["environment"] for exception in exceptions["exceptions"]}
        blocker = {**original, "provider_verified": True,
                   "cases": [row for row in blocker_roster["cases"] if waived.intersection(row["environments"])]}
        source_files = {file: sha256(REPOSITORY_ROOT / file) for file in roster["source_files"]}
        for profile in profile_data:
            for file in profile["source"]["sourceFiles"]:
                full = f"packages/paperclip-runner/{file}" if profile["profile"] == "runner-package" else file
                source_files[full] = sha256(REPOSITORY_ROOT / full)
        payload = {"expected_source": expected, "roster": roster, "source_results": source_results,
                   "profiles": profile_data, "required_profiles": profiles, "claude_results": claude_results,
                   "source_files": source_files, "coverage_policy": policy, "exception_policy": exceptions,
                   "blocker_evidence": blocker}
        write("verified-observation.json", payload)
        live_identity("final")
        output = subprocess.check_output(["node", str(REPOSITORY_ROOT / ".github/scripts/qualification-rollout.mjs"),
                                          str(directory / "verified-observation.json")], cwd=REPOSITORY_ROOT, text=True)
        observed.update(json.loads(output))
        observed.update({"observed_at": now.isoformat(), "provider_archives": bindings,
                         "minimum_remaining_retention_seconds": min(binding["remaining_retention_seconds"] for binding in bindings)})
    except Exception as error:
        observed["rejected"].append(f"{type(error).__name__}: {error}")
        raise
    finally:
        write("coverage-decision.json", observed)


def artifacts(prefix, count, destination):
    receipt = {"schema": "hosted-retention.v1", "qualified": False, "artifacts": [], "rejected": []}
    try:
        receipt.update(event_identity())
        identity(receipt)
        page = 1
        while True:
            response = api(f"actions/runs/{receipt['run_id']}/artifacts?per_page=100&page={page}")
            for artifact in response["artifacts"]:
                if not artifact["name"].startswith(prefix):
                    continue
                retained = {"id": artifact["id"], "name": artifact["name"], "sha256": artifact.get("digest", ""),
                            "created_at": artifact["created_at"], "expires_at": artifact["expires_at"],
                            "expired": artifact["expired"], "workflow_run": artifact.get("workflow_run")}
                receipt["artifacts"].append(retained)
                created = dt.datetime.fromisoformat(artifact["created_at"].replace("Z", "+00:00"))
                expiry = dt.datetime.fromisoformat(artifact["expires_at"].replace("Z", "+00:00"))
                lifetime = (expiry - created).total_seconds()
                retained["retention_seconds"] = lifetime
                require(not artifact["expired"] and lifetime >= MIN_RETENTION_SECONDS,
                        f"Artifact {artifact['id']} lifetime is only {lifetime} seconds")
                digest = retained["sha256"]
                require(digest.startswith("sha256:") and len(digest) == 71, "Provider artifact SHA-256 is missing")
                require(artifact["workflow_run"]["head_sha"] == receipt["head"], "Artifact workflow source mismatch")
            if len(response["artifacts"]) < 100:
                break
            page += 1
        require(len(receipt["artifacts"]) == count,
                f"Expected {count} required artifacts, found {len(receipt['artifacts'])}")
    except Exception as error:
        receipt["rejected"].append(f"{type(error).__name__}: {error}")
        raise
    finally:
        Path(destination).write_text(json.dumps(receipt, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("initialize")
    init.add_argument("directory", type=Path)
    finish = sub.add_parser("seal")
    finish.add_argument("directory", type=Path)
    finish.add_argument("outcome")
    finish.add_argument("--strict-reports", action="store_true")
    finish.add_argument("--defer-environment-skips", action="store_true")
    red = sub.add_parser("expected-red")
    red.add_argument("directory", type=Path)
    original_red = sub.add_parser("retain-original-red")
    original_red.add_argument("directory", type=Path)
    audit = sub.add_parser("artifacts")
    audit.add_argument("prefix")
    audit.add_argument("count", type=int)
    audit.add_argument("destination")
    observer = sub.add_parser("observe-rollout")
    observer.add_argument("request", type=Path)
    observer.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "initialize":
        initialize(args.directory)
    elif args.command == "seal":
        seal(args.directory, args.outcome, args.strict_reports, args.defer_environment_skips)
    elif args.command == "expected-red":
        expected_red(args.directory)
    elif args.command == "retain-original-red":
        retain_original_red(args.directory)
    elif args.command == "observe-rollout":
        observe_rollout(args.request, args.directory)
    else:
        artifacts(args.prefix, args.count, args.destination)


if __name__ == "__main__":
    main()
