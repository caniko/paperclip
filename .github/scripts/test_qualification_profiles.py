"""Reject evidence substitutions and preserve literal mandatory outcomes."""
import unittest
import xml.etree.ElementTree as ET

from verify_profile_evidence import project_profile_report


class ProfileEvidence(unittest.TestCase):
    def setUp(self):
        self.selection = {"profile": "sdk", "requiredCases": [{"id": "1", "file": "source.test.ts",
            "name": "real SDK > passing", "required": True, "skipped_in_environment": False}]}
        self.raw = b'<testsuites><testsuite name="source.test.ts" tests="2"><testcase classname="source.test.ts" name="real SDK &gt; passing [vitest:1]" time="0.1"/><testcase classname="source.test.ts" name="other OS [vitest:2]"><skipped/></testcase></testsuite></testsuites>'

    def test_projection_preserves_mandatory_case_and_reports_truthful_counts(self):
        root = ET.fromstring(project_profile_report(self.raw, self.selection))
        self.assertEqual(root.get("tests"), "1")
        self.assertEqual(root.find("testsuite").get("tests"), "1")
        self.assertEqual(root.find(".//testcase").get("name"), "real SDK > passing [vitest:1]")
        self.assertFalse(root.findall(".//skipped"))

    def test_missing_duplicate_cross_source_renamed_skipped_and_failed_evidence_is_rejected(self):
        for raw in [self.raw.replace(b"[vitest:1]", b"[vitest:3]"),
                    self.raw.replace(b"[vitest:2]", b"[vitest:1]"),
                    self.raw.replace(b'classname="source.test.ts"', b'classname="foreign.test.ts"'),
                    self.raw.replace(b"real SDK", b"different title"),
                    self.raw.replace(b'time="0.1"/>', b'time="0.1"><skipped/></testcase>'),
                    self.raw.replace(b"<skipped/>", b"<failure/>"),
                    self.raw.replace(b"<skipped/>", b"<error/>"),
                    self.raw.replace(b"</testsuite>", b'<container><testcase name="another [vitest:1]"/></container></testsuite>'),
                    self.raw.replace(b"<skipped/>", b"<flakyFailure/>")]:
            with self.subTest(raw=raw), self.assertRaises(AssertionError):
                project_profile_report(raw, self.selection)


if __name__ == "__main__":
    unittest.main()
