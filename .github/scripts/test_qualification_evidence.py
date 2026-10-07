import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("evidence", Path(__file__).with_name("qualification-evidence.py"))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class ReceiptTests(unittest.TestCase):
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
