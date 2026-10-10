"""Project mandatory profile cases without changing the retained raw report."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET


def project_profile_report(raw, selection):
    root = ET.fromstring(raw)
    assert not root.findall(".//failure") and not root.findall(".//error"), "Raw execution failed"
    assert not any("retry" in node.tag.lower() or "flaky" in node.tag.lower() for node in root.iter())
    expected = {row["id"]: row for row in selection["requiredCases"]}
    assert expected and len(expected) == len(selection["requiredCases"]), "Ambiguous required identities"
    assert root.tag == "testsuites", "Unexpected raw report root"
    assert sum(len(suite.findall("testcase")) for suite in root.findall("testsuite")) == len(root.findall(".//testcase")), "Unrecognized nested raw cases"
    projected = ET.Element("testsuites", {"name": selection["profile"], "tests": str(len(expected)), "failures": "0", "errors": "0"})
    seen, found = set(), set()
    for suite in root.findall("testsuite"):
        selected = []
        for case in suite.findall("testcase"):
            match = re.fullmatch(r"(.+) \[vitest:([^\]]+)\]", case.get("name", ""))
            assert match, "Missing raw framework identity"
            name, identity = match.groups()
            assert identity not in seen, "Duplicate raw execution identity"
            seen.add(identity)
            if identity not in expected:
                continue
            row = expected[identity]
            assert case.get("classname") == row["file"], "Wrong executing source file"
            assert name == row["name"], "Raw case title differs from its collected identity"
            assert row["required"] and not row["skipped_in_environment"], "Invalid profile prerequisites"
            assert case.find("skipped") is None, "Mandatory case skipped"
            selected.append(copy.deepcopy(case))
            found.add(identity)
        if selected:
            attributes = {key: value for key, value in suite.attrib.items() if key not in {"tests", "failures", "errors", "skipped", "time"}}
            attributes.update(tests=str(len(selected)), failures="0", errors="0", skipped="0",
                              time=str(sum(float(case.get("time", "0")) for case in selected)))
            target = ET.SubElement(projected, "testsuite", attributes)
            target.extend(selected)
    assert found == expected.keys(), "Required profile execution is missing"
    return ET.tostring(projected, encoding="utf-8", xml_declaration=True) + b"\n"


def main(directory):
    raw = (directory / "raw-results.junit").read_bytes()
    selection_raw = (directory / "profile-selection.json").read_bytes()
    result = json.loads((directory / "profile-result.json").read_bytes())
    selection = json.loads(selection_raw)
    assert result["scopedExecutionVerified"] and not result["producerAcceptanceQualified"]
    assert result["requiredCases"] == len(selection["requiredCases"])
    projected = project_profile_report(raw, selection)
    with (directory / "profile.xml").open("xb") as stream:
        stream.write(projected)
    with (directory / "profile-report-binding.json").open("x") as stream:
        json.dump({"profile": selection["profile"], "rawReportSha256": hashlib.sha256(raw).hexdigest(),
                   "selectionSha256": hashlib.sha256(selection_raw).hexdigest(),
                   "profileReportSha256": hashlib.sha256(projected).hexdigest(),
                   "projectorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   "rawReportPreserved": True, "requiredCases": len(selection["requiredCases"]),
                   "producerAcceptanceQualified": False}, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
