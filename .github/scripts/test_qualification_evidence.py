import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
