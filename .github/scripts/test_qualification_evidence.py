import importlib.util
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from urllib.error import URLError

spec = importlib.util.spec_from_file_location("evidence", Path(__file__).with_name("qualification-evidence.py"))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pr = {"number": 4, "head": {"sha": "candidate"}, "base": {"sha": "target"}}
        event = self.root / "event.json"
        event.write_text(json.dumps({"pull_request": self.pr}))
        env = {"GITHUB_EVENT_PATH": str(event), "GITHUB_EVENT_NAME": "pull_request",
               "GITHUB_RUN_ATTEMPT": "1", "GITHUB_REPOSITORY": "caniko/paperclip",
               "GITHUB_WORKFLOW_REF": "workflow", "GITHUB_WORKFLOW_SHA": "workflow-source",
               "GITHUB_RUN_ID": "1", "GITHUB_RETENTION_DAYS": "31", "RUNNER_ENVIRONMENT": "github-hosted"}
        environment = patch.dict(os.environ, env)
        environment.start()
        self.addCleanup(environment.stop)
        harness = patch.object(evidence, "harness_identity", return_value={"harness_sha256": "fixture-harness", "harness_files": {}})
        harness.start()
        self.addCleanup(harness.stop)

    def test_identity_rejects_moved_head_or_base(self):
        with patch.object(evidence, "api", return_value=self.pr) as api:
            self.assertEqual(evidence.identity(evidence.event_identity())["base"], "target")
            api.assert_called_once_with("pulls/4")
            for field in ["head", "base"]:
                api.return_value = {**self.pr, field: {"sha": "moved"}}
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, f"PR {field} advanced"):
                    evidence.identity(evidence.event_identity())

    def test_initialization_refusals_keep_bound_failure_evidence(self):
        refusals = [({**self.pr, "head": {"sha": "moved"}}, {}, "candidate", "PR head advanced"),
                    ({**self.pr, "base": {"sha": "moved"}}, {}, "candidate", "PR base advanced"),
                    (self.pr, {"GITHUB_RUN_ATTEMPT": "2"}, "candidate", "Retries cannot qualify"),
                    (self.pr, {"RUNNER_ENVIRONMENT": "self-hosted"}, "candidate", "Only GitHub-hosted"),
                    (self.pr, {"GITHUB_RETENTION_DAYS": "30"}, "candidate", "must allow 31 days"),
                    (self.pr, {}, "merge-revision", "Checkout is not the exact PR head")]
        for index, (live, env, revision, reason) in enumerate(refusals):
            with self.subTest(reason=reason), patch.dict(os.environ, env), \
                    patch.object(evidence, "api", return_value=live), \
                    patch.object(evidence.subprocess, "check_output", return_value=revision + "\n"):
                directory = self.root / str(index)
                with self.assertRaisesRegex(RuntimeError, reason):
                    evidence.initialize(directory)
                source = json.loads((directory / "source.json").read_text())
                self.assertFalse(source["initialized"])
                self.assertEqual(source["head"], "candidate")
                self.assertEqual(source["base"], "target")
                self.assertEqual(source["tested_source"], revision)
                self.assertEqual(source["run_attempt"], int(os.environ["GITHUB_RUN_ATTEMPT"]))
                self.assertIn(reason, source["initialization_error"])
                self.assertEqual(source["receipt_tool_sha256"], evidence.sha256(evidence.__file__))
                self.assertEqual(source["event_sha256"], evidence.sha256(os.environ["GITHUB_EVENT_PATH"]))
                if "PR " in reason:
                    self.assertEqual(source["observed_pr"], {"head": live["head"]["sha"], "base": live["base"]["sha"]})
                (directory / "readiness.log").write_text(reason + "\n")
                evidence.seal(directory, "failure", True)
                receipt = json.loads((directory / "receipt.json").read_text())
                self.assertFalse(receipt["qualified"])
                self.assertIn(reason, "; ".join(receipt["rejected"]))
                self.assertEqual(receipt["members"]["source.json"], evidence.sha256(directory / "source.json"))
                self.assertEqual(receipt["members"]["readiness.log"], evidence.sha256(directory / "readiness.log"))
                (directory / "cases.xml").write_text('<testsuite><testcase name="passed"/></testsuite>')
                for outcome in ["success", "expected-red"]:
                    with self.subTest(outcome=outcome), self.assertRaisesRegex(RuntimeError, reason):
                        evidence.seal(directory, outcome, True)

    def test_provider_failure_keeps_initialization_receipt(self):
        directory = self.root / "provider-failure"
        with patch.object(evidence, "api", side_effect=URLError("provider unavailable")), \
                patch.object(evidence.subprocess, "check_output", return_value="candidate\n"):
            with self.assertRaises(URLError):
                evidence.initialize(directory)
        evidence.seal(directory, "failure", False)
        receipt = json.loads((directory / "receipt.json").read_text())
        self.assertEqual(receipt["head"], "candidate")
        self.assertFalse(receipt["initialized"])
        self.assertIn("provider unavailable", receipt["initialization_error"])

    def test_invalid_event_keeps_raw_event_digest_without_claiming_initialization(self):
        event = Path(os.environ["GITHUB_EVENT_PATH"])
        event.write_text('{"pull_request":')
        directory = self.root / "invalid-event"
        with patch.object(evidence, "api") as api:
            with self.assertRaises(json.JSONDecodeError):
                evidence.initialize(directory)
            api.assert_not_called()
        evidence.seal(directory, "failure", False)
        receipt = json.loads((directory / "receipt.json").read_text())
        self.assertFalse(receipt["initialized"])
        self.assertFalse(receipt["qualified"])
        self.assertEqual(receipt["event_sha256"], evidence.sha256(event))
        self.assertNotIn("tested_source", receipt)

    def test_successful_initialization_and_complete_report_can_be_sealed(self):
        directory = self.root / "success"
        with patch.object(evidence, "api", return_value=self.pr), \
                patch.object(evidence.subprocess, "check_output", return_value="candidate\n"):
            evidence.initialize(directory)
        (directory / "cases.xml").write_text('<testsuite><testcase classname="suite" name="passed"/></testsuite>')
        evidence.seal(directory, "success", True)
        receipt = json.loads((directory / "receipt.json").read_text())
        self.assertTrue(receipt["initialized"])
        self.assertFalse(receipt["qualified"])
        self.assertEqual(receipt["rejected"], [])
        self.assertEqual(receipt["reports"][0]["cases"], 1)

    def test_mandatory_results_reject_missing_failed_skipped_retried_and_duplicate_cases(self):
        reports = [None, '<testsuite/>', '<testsuite><testcase><failure/></testcase></testsuite>',
                   '<testsuite><testcase><error/></testcase></testsuite>',
                   '<testsuite><testcase><skipped/></testcase></testsuite>',
                   '<testsuite><testcase><flakyFailure/></testcase></testsuite>',
                   '<testsuite><testcase classname="a" name="b"/><testcase classname="a" name="b"/></testsuite>']
        for report in reports:
            with self.subTest(report=report), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                (directory / "source.json").write_text('{"initialized":true}')
                if report:
                    (directory / "cases.xml").write_text(report)
                with self.assertRaises(RuntimeError):
                    evidence.seal(directory, "success", True)

    def test_failed_evidence_is_bound_without_becoming_qualification(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "source.json").write_text('{"head":"original","initialized":true}')
            (directory / "cases.xml").write_text('<testsuite><testcase name="regression"><failure/></testcase></testsuite>')
            evidence.seal(directory, "failure", True)
            receipt = json.loads((directory / "receipt.json").read_text())
            self.assertFalse(receipt["qualified"])
            self.assertEqual(receipt["head"], "original")
            self.assertEqual(receipt["reports"][0]["failures"], 1)
            self.assertEqual(receipt["members"]["cases.xml"], evidence.sha256(directory / "cases.xml"))

    def test_source_environment_deferrals_preserve_raw_skips_without_execution_credit(self):
        directory = self.root / "deferred"
        directory.mkdir()
        (directory / "source.json").write_text('{"initialized":true}')
        file = "server/sdk.test.ts"
        source = self.root / file
        source.parent.mkdir()
        source.write_text('describe.skipIf(!sdk)("real SDK", () => {});')
        policy = {"all_declared_cases_required": True,
                  "environments": {"otel-sdk": {"platform": "linux"}},
                  "rules": [{"file": file, "source_sha256": evidence.sha256(source),
                             "anchor": "describe.skipIf(!sdk)", "name_contains": "real SDK",
                             "environment": "otel-sdk"}]}
        raw = '<testsuite><testcase classname="server/sdk.test.ts" name="real SDK &gt; renders [vitest:case-1]"><skipped/></testcase></testsuite>'
        (directory / "cases.xml").write_text(raw)
        with patch.object(evidence, "REPOSITORY_ROOT", self.root), \
                patch.object(evidence, "environment_policy", return_value=policy):
            evidence.seal(directory, "success", True, defer_environment_skips=True)
            receipt = json.loads((directory / "receipt.json").read_text())
            self.assertFalse(receipt["qualified"])
            self.assertEqual(receipt["reports"][0]["skipped"], 1)
            self.assertEqual(receipt["environment_deferrals"][0], {
                "file": file, "name": "real SDK > renders", "id": "case-1",
                "source_sha256": evidence.sha256(source), "environments": ["otel-sdk"],
                "required": True, "execution_evidence": False})
            self.assertEqual((directory / "cases.xml").read_text(), raw)
            source.write_text(source.read_text() + "// drift")
            with self.assertRaisesRegex(RuntimeError, "source|Source"):
                evidence.seal(directory, "success", True, defer_environment_skips=True)

    def test_source_deferrals_reject_unknown_cases_and_cannot_conceal_failures(self):
        directory = self.root / "unknown-deferral"
        directory.mkdir()
        (directory / "source.json").write_text('{"initialized":true}')
        policy = {"all_declared_cases_required": True, "environments": {}, "rules": []}
        with patch.object(evidence, "environment_policy", return_value=policy):
            for body in ['<skipped/>', '<failure/>', '<error/>']:
                (directory / "cases.xml").write_text(
                    '<testsuite><testcase classname="unknown.test.ts" name="unknown [vitest:case-1]">'
                    + body + '</testcase></testsuite>')
                with self.subTest(body=body), self.assertRaises(RuntimeError):
                    evidence.seal(directory, "success", True, defer_environment_skips=True)

    def test_malformed_failed_reports_are_preserved_and_cannot_pass(self):
        for index, report in enumerate(['<testsuite/>', '<testsuite><testcase']):
            with self.subTest(report=report):
                directory = self.root / f"malformed-{index}"
                directory.mkdir()
                (directory / "source.json").write_text('{"initialized":true}')
                (directory / "cases.xml").write_text(report)
                evidence.seal(directory, "failure", True)
                receipt = json.loads((directory / "receipt.json").read_text())
                self.assertFalse(receipt["qualified"])
                self.assertTrue(receipt["rejected"])
                self.assertEqual(receipt["members"]["cases.xml"], evidence.sha256(directory / "cases.xml"))
                with self.assertRaises(RuntimeError):
                    evidence.seal(directory, "success", True)

    def test_retention_refusals_preserve_provider_readback(self):
        artifact = {"id": 7, "name": "source-proof-tests-candidate-1", "digest": "sha256:" + "a" * 64,
                    "created_at": "2026-10-08T00:00:00Z", "expires_at": "2026-11-08T00:00:00Z",
                    "expired": False, "workflow_run": {"head_sha": "candidate"}}
        refusals = [({"expires_at": "2026-10-09T00:00:00Z"}, "lifetime is only"),
                    ({"expired": True}, "lifetime is only"),
                    ({"digest": ""}, "Provider artifact SHA-256 is missing"),
                    ({"workflow_run": {"head_sha": "other"}}, "Artifact workflow source mismatch")]
        for index, (changes, reason) in enumerate(refusals):
            observed = {**artifact, **changes}
            destination = self.root / f"retention-{index}.json"
            with self.subTest(reason=reason), \
                    patch.object(evidence, "api", side_effect=[self.pr, {"artifacts": [observed]}]):
                with self.assertRaisesRegex(RuntimeError, reason):
                    evidence.artifacts("source-proof-", 1, destination)
                receipt = json.loads(destination.read_text())
                self.assertFalse(receipt["qualified"])
                self.assertEqual(receipt["head"], "candidate")
                self.assertEqual(receipt["artifacts"][0]["sha256"], observed["digest"])
                self.assertEqual(receipt["artifacts"][0]["expires_at"], observed["expires_at"])
                self.assertIn(reason, receipt["rejected"][0])

    def test_retention_stale_identity_and_missing_artifacts_keep_refusal_receipt(self):
        responses = [({**self.pr, "base": {"sha": "moved"}}, "PR base advanced"),
                     (self.pr, "Expected 5 required artifacts, found 0")]
        for index, (live, reason) in enumerate(responses):
            destination = self.root / f"retention-source-{index}.json"
            with self.subTest(reason=reason), \
                    patch.object(evidence, "api", side_effect=[live, {"artifacts": []}]):
                with self.assertRaisesRegex(RuntimeError, reason):
                    evidence.artifacts("source-proof-", 5, destination)
                receipt = json.loads(destination.read_text())
                self.assertEqual(receipt["base"], "target")
                self.assertFalse(receipt["qualified"])
                self.assertIn(reason, receipt["rejected"][0])

    def test_supported_retention_still_requires_independent_acceptance(self):
        artifact = {"id": 7, "name": "source-proof-tests-candidate-1", "digest": "sha256:" + "a" * 64,
                    "created_at": "2026-10-08T00:00:00Z", "expires_at": "2026-11-08T00:00:00Z",
                    "expired": False, "workflow_run": {"head_sha": "candidate"}}
        destination = self.root / "retention-success.json"
        with patch.object(evidence, "api", side_effect=[self.pr, {"artifacts": [artifact]}]):
            evidence.artifacts("source-proof-", 1, destination)
        receipt = json.loads(destination.read_text())
        self.assertFalse(receipt["qualified"])
        self.assertEqual(receipt["rejected"], [])
        self.assertEqual(receipt["artifacts"][0]["retention_seconds"], 31 * 24 * 60 * 60)

    def test_original_red_reference_verifies_archive_members_and_never_reexecutes_tests(self):
        source = {"baseline": "f6451f242d5cbb803e3c265e90f05b642e573203",
                  "head": "9192d66579850b36cf10abd651b41804cfa75447", "run_id": 39157504264,
                  "run_attempt": 1, "runner_environment": "github-hosted", "regression_fixture_sha256": "fixture"}
        xml = '<testsuite>' + ''.join('<testcase name="case-' + str(i) + '">' +
              ('<failure/>' if i < 20 else '') + '</testcase>' for i in range(23)) + '</testsuite>'
        members = {"source.json": json.dumps(source).encode(), "regression.xml": xml.encode()}
        receipt = {**source, "outcome": "expected-red", "qualified": False, "rejected": [],
                   "members": {name: hashlib.sha256(data).hexdigest() for name, data in members.items()}}
        members["receipt.json"] = json.dumps(receipt).encode()
        def archive(files):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as writer:
                for name, data in files.items():
                    writer.writestr(name, data)
            return stream.getvalue()
        raw = archive(members)
        pinned = {"artifact_id": 12146584669, "run_id": source["run_id"], "head": source["head"],
                  "archive_sha256": hashlib.sha256(raw).hexdigest(), "fixture_sha256": "fixture"}
        metadata = {"id": pinned["artifact_id"], "expired": False,
                    "digest": "sha256:" + pinned["archive_sha256"], "workflow_run": {"id": source["run_id"], "head_sha": source["head"]}}
        result = evidence.verify_original_red(raw, metadata, pinned)
        self.assertFalse(result["execution_credit"])
        self.assertEqual(result["original_cases"], 23)
        self.assertEqual(result["original_assertion_failures"], 20)
        for mutated_raw, mutated_metadata in [(raw + b"tampered", metadata), (raw, {**metadata, "expired": True}),
                (raw, {**metadata, "workflow_run": {"id": source["run_id"], "head_sha": "other"}})]:
            with self.subTest(metadata=mutated_metadata), self.assertRaises(RuntimeError):
                evidence.verify_original_red(mutated_raw, mutated_metadata, pinned)
        changed = archive({**members, "regression.xml": b"changed"})
        with self.assertRaisesRegex(RuntimeError, "member"):
            evidence.verify_original_red(changed, {**metadata, "digest": "sha256:" + hashlib.sha256(changed).hexdigest()},
                                         {**pinned, "archive_sha256": hashlib.sha256(changed).hexdigest()})

    def test_provider_archive_requires_exact_source_harness_remaining_retention_and_complete_members(self):
        expected = {"repository": "caniko/paperclip", "pull_request": 5, "head": "candidate", "base": "base",
                    "tree": "tree", "harness_sha256": "harness", "policy_sha256": "policy",
                    "exception_policy_sha256": "exceptions"}
        source = {**expected, "pr": 5, "run_id": 7, "run_attempt": 1, "runner_environment": "github-hosted",
                  "tested_source": "candidate", "initialized": True, "outcome": "success", "qualified": False,
                  "rejected": [], "members": {"cases.xml": hashlib.sha256(b"report").hexdigest()}}
        def archive(receipt=source, extra=None):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as writer:
                writer.writestr("receipt.json", json.dumps(receipt))
                writer.writestr("cases.xml", b"report")
                for name, value in (extra or {}).items():
                    writer.writestr(name, value)
            return stream.getvalue()
        raw = archive()
        metadata = {"id": 8, "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "expired": False,
                    "created_at": "2026-10-18T00:00:00Z", "expires_at": "2026-11-19T00:00:00Z",
                    "workflow_run": {"id": 7, "head_sha": "candidate"}}
        now = dt.datetime(2026, 10, 19, tzinfo=dt.timezone.utc)
        members, receipt = evidence.verify_provider_archive(raw, metadata, expected, 7, now)
        self.assertEqual(members["cases.xml"], b"report")
        self.assertFalse(receipt["qualified"])
        for changes in [{"expired": True}, {"expires_at": "2026-11-17T23:59:59Z"},
                        {"digest": "sha256:" + "f" * 64}, {"workflow_run": {"id": 9, "head_sha": "candidate"}}]:
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                evidence.verify_provider_archive(raw, {**metadata, **changes}, expected, 7, now)
        for changes in [{"head": "old"}, {"base": "old"}, {"tree": "old"}, {"harness_sha256": "old"},
                        {"policy_sha256": "old"}, {"exception_policy_sha256": "old"}, {"run_attempt": 2},
                        {"outcome": "failure"}, {"rejected": ["skip"]}, {"runner_environment": "self-hosted"},
                        {"initialized": False}, {"members": {"cases.xml": "wrong"}}]:
            changed = archive({**source, **changes})
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                evidence.verify_provider_archive(changed, {**metadata, "digest": "sha256:" + hashlib.sha256(changed).hexdigest()}, expected, 7, now)
        for name in ["../escaped", "/absolute", "directory\\escaped", "unbound"]:
            changed = archive(extra={name: b"unbound"})
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                evidence.verify_provider_archive(changed, {**metadata, "digest": "sha256:" + hashlib.sha256(changed).hexdigest()}, expected, 7, now)

    def test_rollout_observer_downloads_bound_originals_and_runs_the_union_decision(self):
        real_check_output = evidence.subprocess.check_output
        decision_script = evidence.REPOSITORY_ROOT / ".github/scripts/qualification-rollout.mjs"
        expected = {"repository": "caniko/paperclip", "pull_request": 5, "head": "candidate", "base": "base",
                    "tree": "tree", "harness_sha256": "harness", "policy_sha256": "policy", "exception_policy_sha256": "exceptions"}
        file = "fixture.test.ts"
        (self.root / file).write_text("// Source-bound observer contract.\n")
        digest = evidence.sha256(self.root / file)
        def row(identity, environment):
            return {"id": identity, "name": identity, "file": file, "project": "contract", "source_sha256": digest,
                    "environments": [environment], "environment_mapping": "source-backed"}
        rows = [row("default", "default-hosted"), row("profile", "runnerd"), row("claude", "live-claude-code"), row("cloud", "cloud")]
        def archive(members):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as writer:
                for name, value in members.items():
                    writer.writestr(name, value if isinstance(value, bytes) else json.dumps(value))
            return stream.getvalue()
        blocker_raw = archive({"coverage-map.json": {"cases": [rows[-1]]}})
        with zipfile.ZipFile(io.BytesIO(blocker_raw)) as reader:
            blocker_digest = hashlib.sha256(reader.read("coverage-map.json")).hexdigest()
        exceptions = {"schema": "paperclip.rollout-exceptions.v1", "repository": expected["repository"], "pull_request": 5,
                      "authorization": "Observer contract fixture", "execution_credit": False,
                      "original_inventory": {"artifact_id": 900, "run_id": 90, "head": "original",
                         "archive_sha256": hashlib.sha256(blocker_raw).hexdigest(), "member": "coverage-map.json",
                         "member_sha256": blocker_digest, "execution_credit": False},
                      "exceptions": [{"environment": "cloud", "reason": "Retained contract blocker", "max_cases": 1}]}
        policy = {"all_declared_cases_required": True, "environments": {"runnerd": {"platform": "linux"}}, "rules": []}
        workflow_root = self.root / ".github/workflows"
        workflow_root.mkdir(parents=True)
        (workflow_root / "source-qualification.yml").write_text("          - lane: tests-contract\n")
        (workflow_root / "qualification-environments.yml").write_text("          - profile: runnerd\n")
        policy_path = self.root / ".github/qualification/rollout-exceptions.json"
        policy_path.parent.mkdir(parents=True)
        policy_path.write_text(json.dumps(exceptions))
        runs = {"source": 101, "coverage": 102, "environments": 103, "claude": 104}
        workflows = ["source-qualification.yml", "qualification-coverage.yml", "qualification-environments.yml", "qualification-live-claude.yml"]
        run_data = {run: {"id": run, "run_attempt": 1, "status": "completed", "conclusion": "success", "event": "pull_request",
                         "head_sha": "candidate", "path": f".github/workflows/{workflow}",
                         "pull_requests": [{"number": 5, "head": {"sha": "candidate"}, "base": {"sha": "base"}}]}
                    for run, workflow in zip(runs.values(), workflows)}
        def xml(identity):
            return f'<testsuite><testcase classname="{file}" name="{identity} [vitest:{identity}]"/></testsuite>'.encode()
        selected = {"profile": "runnerd", "platform": "linux", "requiredCases": [rows[1]]}
        roster = {**expected, "source_files": {file: digest}, "cases": rows, "all_declared_cases_required": True,
                  "collection_errors": [], "missing_specifications": [], "stale_mapping_rules": [],
                  "declaration_sites": [{"runtime_case_ids_at_site": [row["id"]]} for row in rows]}
        payloads = [(101, "source-proof-tests-contract", {"cases.xml": xml("default")}),
                    (101, "source-proof-expected-red", {"original-red.zip": b"independently-verified-red", "original-red-provider.json": {}}),
                    (102, "complete-coverage-map", {"coverage-map.json": roster}),
                    (103, "required-profile-runnerd", {"profile.xml": xml("profile"), "profile-selection.json": selected,
                       "profile-source.json": {**expected, "profile": "runnerd", "diagnostic": False, "platform": "linux",
                                               "policySha256": "policy", "sourceFiles": {file: digest}},
                       "profile-raw-results.json": {"cases": [{**rows[1], "outcome": "passed", "retryCount": 0, "repeatCount": 0}], "errors": []}}),
                    (104, "live-claude", {"cases.xml": xml("claude")})]
        artifacts, downloads = {}, {}
        def provider(artifact_id, run, head, raw, name):
            return {"id": artifact_id, "name": name, "expired": False, "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
                    "created_at": "2026-10-18T00:00:00Z", "expires_at": "2099-01-01T00:00:00Z",
                    "workflow_run": {"id": run, "head_sha": head}}
        for artifact_id, (run, name, members) in enumerate(payloads, 500):
            members = {name: value if isinstance(value, bytes) else json.dumps(value).encode() for name, value in members.items()}
            receipt = {**expected, "pr": 5, "tested_source": "candidate", "run_id": run, "run_attempt": 1,
                       "runner_environment": "github-hosted", "initialized": True, "outcome": "success", "qualified": False,
                       "rejected": [], "members": {name: hashlib.sha256(value).hexdigest() for name, value in members.items()}}
            raw = archive({**members, "receipt.json": receipt})
            artifacts.setdefault(run, []).append(provider(artifact_id, run, "candidate", raw, name + "-candidate-1"))
            downloads[artifact_id] = raw
        downloads[900] = blocker_raw
        def api(endpoint):
            if endpoint == "pulls/5":
                return {"head": {"sha": "candidate"}, "base": {"sha": "base"}}
            if endpoint == "actions/artifacts/900":
                return provider(900, 90, "original", blocker_raw, "original")
            run = int(endpoint.split("/")[2])
            if "jobs?" in endpoint:
                return {"jobs": [{"id": run, "run_attempt": 1, "status": "completed", "conclusion": "success",
                                  "labels": ["ubuntu-24.04"], "runner_group_name": "GitHub Actions"}]}
            if "artifacts?" in endpoint:
                return {"artifacts": artifacts[run]}
            return run_data[run]
        def command(argv, **kwargs):
            if argv[:2] == ["git", "rev-parse"]:
                return "tree\n" if argv[-1] == "HEAD^{tree}" else "candidate\n"
            if argv[:2] == ["git", "diff"]:
                return b""
            if argv[0] == "node":
                return real_check_output(["node", str(decision_script), argv[-1]], text=True)
            if argv[-1].endswith("/logs"):
                return archive({"original.log": b"Contract execution log\n"})
            return downloads[int(argv[-1].split("/")[-2])]
        request = self.root / "observer-request.json"
        request.write_text(json.dumps({**expected, "runs": runs}))
        with patch.object(evidence, "REPOSITORY_ROOT", self.root), patch.object(evidence, "api", side_effect=api), \
                patch.object(evidence, "environment_policy", return_value=policy), \
                patch.object(evidence, "harness_identity", return_value={key: expected[key] for key in
                    ["harness_sha256", "policy_sha256", "exception_policy_sha256"]}), \
                patch.object(evidence, "verify_original_red") as original_red, \
                patch.object(evidence.subprocess, "check_output", side_effect=command):
            destination = self.root / "observer-green"
            evidence.observe_rollout(request, destination)
            decision = json.loads((destination / "coverage-decision.json").read_text())
            self.assertTrue(decision["rollout_coverage_accepted"])
            self.assertFalse(decision["qualified"])
            self.assertFalse(decision["producer_acceptance_qualified"])
            self.assertEqual(len(decision["provider_archives"]), 6)
            self.assertEqual(decision["executed_cases"], 3)
            original_red.assert_called_once()
            run_data[101]["run_attempt"] = 2
            rejected = self.root / "observer-red"
            with self.assertRaisesRegex(RuntimeError, "attempt-1"):
                evidence.observe_rollout(request, rejected)
            refusal = json.loads((rejected / "coverage-decision.json").read_text())
            self.assertFalse(refusal["qualified"])
            self.assertIn("attempt-1", refusal["rejected"][0])
            self.assertEqual(json.loads((rejected / "source/run.json").read_text())["run_attempt"], 2)
if __name__ == "__main__":
    unittest.main()
