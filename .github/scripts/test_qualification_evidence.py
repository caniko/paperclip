import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("evidence", Path(__file__).with_name("qualification-evidence.py"))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class ReceiptTests(unittest.TestCase):
    def test_identity_rejects_moved_head_or_base(self):
        pr = {"number": 4, "head": {"sha": "candidate"}, "base": {"sha": "target"}}
        with tempfile.TemporaryDirectory() as root:
            event = Path(root) / "event.json"
            event.write_text(json.dumps({"pull_request": pr}))
            env = {"GITHUB_EVENT_PATH": str(event), "GITHUB_EVENT_NAME": "pull_request",
                   "GITHUB_RUN_ATTEMPT": "1", "GITHUB_REPOSITORY": "caniko/paperclip",
                   "GITHUB_WORKFLOW_REF": "workflow", "GITHUB_WORKFLOW_SHA": "workflow-source",
                   "GITHUB_RUN_ID": "1"}
            with patch.dict(os.environ, env), patch.object(evidence, "api", return_value=pr) as api:
                self.assertEqual(evidence.identity()["base"], "target")
                api.assert_called_once_with("pulls/4")
                for field in ["head", "base"]:
                    api.return_value = {**pr, field: {"sha": "moved"}}
                    with self.subTest(field=field), self.assertRaises(RuntimeError):
                        evidence.identity()

    def test_mandatory_results_reject_missing_failed_skipped_retried_and_duplicate_cases(self):
        reports = [None, '<testsuite/>', '<testsuite><testcase><failure/></testcase></testsuite>',
                   '<testsuite><testcase><error/></testcase></testsuite>',
                   '<testsuite><testcase><skipped/></testcase></testsuite>',
                   '<testsuite><testcase><flakyFailure/></testcase></testsuite>',
                   '<testsuite><testcase classname="a" name="b"/><testcase classname="a" name="b"/></testsuite>']
        for report in reports:
            with self.subTest(report=report), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                (directory / "source.json").write_text('{}')
                if report:
                    (directory / "cases.xml").write_text(report)
                with self.assertRaises(RuntimeError):
                    evidence.seal(directory, "success", True)

    def test_failed_evidence_is_bound_without_becoming_qualification(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "source.json").write_text('{"head":"original"}')
            (directory / "cases.xml").write_text('<testsuite><testcase name="regression"><failure/></testcase></testsuite>')
            evidence.seal(directory, "failure", True)
            receipt = json.loads((directory / "receipt.json").read_text())
            self.assertFalse(receipt["qualified"])
            self.assertEqual(receipt["head"], "original")
            self.assertEqual(receipt["reports"][0]["failures"], 1)
            self.assertEqual(receipt["members"]["cases.xml"], evidence.sha256(directory / "cases.xml"))


if __name__ == "__main__":
    unittest.main()
