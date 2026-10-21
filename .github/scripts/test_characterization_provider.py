"""Reject substituted package bytes, identities and executable archive members."""

import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest


spec = importlib.util.spec_from_file_location(
    "provider", Path(__file__).with_name("prepare-characterization-provider.py"))
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def fixture(name="fixture", version="1", binary_type=tarfile.REGTYPE, duplicate=False):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, data, kind in [("package/package.json", json.dumps({"name": name, "version": version}).encode(), tarfile.REGTYPE),
                                 ("package/claude", b"fixture binary", binary_type)]:
            member = tarfile.TarInfo(path)
            member.type = kind
            member.size = len(data) if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(data))
            if duplicate and path == "package/claude":
                archive.addfile(member, io.BytesIO(data))
    raw = buffer.getvalue()
    policy = {"name": "fixture", "version": "1", "binary_member": "package/claude",
              "integrity": "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()}
    return raw, policy


class CharacterizationProvider(unittest.TestCase):
    def test_accepts_the_bound_regular_binary_without_extracting_paths(self):
        raw, policy = fixture()
        self.assertEqual(provider.binary_from_archive(raw, policy), b"fixture binary")

    def test_rejects_tampered_archive_and_substituted_identity(self):
        raw, policy = fixture()
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            provider.binary_from_archive(raw + b"tampered", policy)
        for changed in [dict(policy, name="other"), dict(policy, version="2")]:
            with self.subTest(policy=changed), self.assertRaisesRegex(ValueError, "identity mismatch"):
                provider.binary_from_archive(raw, changed)

    def test_rejects_duplicate_and_link_executable_members(self):
        for options in [{"duplicate": True}, {"binary_type": tarfile.SYMTYPE}, {"binary_type": tarfile.LNKTYPE}]:
            raw, policy = fixture(**options)
            with self.subTest(options=options), self.assertRaises(ValueError):
                provider.binary_from_archive(raw, policy)
