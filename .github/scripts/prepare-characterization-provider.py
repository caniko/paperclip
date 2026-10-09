"""Install a source-pinned native characterization binary, without npm scripts."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request


def binary_from_archive(raw, provider):
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    if integrity != provider["integrity"]:
        raise ValueError("Characterization provider integrity mismatch")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate provider archive member")
        metadata = archive.getmember("package/package.json")
        binary = archive.getmember(provider["binary_member"])
        if not metadata.isfile() or not binary.isfile():
            raise ValueError("Provider metadata and binary must be regular files")
        manifest = json.load(archive.extractfile(metadata))
        if manifest["name"] != provider["name"] or manifest["version"] != provider["version"]:
            raise ValueError("Provider package identity mismatch")
        return archive.extractfile(binary).read()


def main():
    if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or os.environ.get("GITHUB_RUN_ATTEMPT") != "1":
        raise ValueError("Characterization preparation requires hosted attempt one")
    provider_path = Path(".github/qualification/claude-characterization-provider.json")
    provider = json.loads(provider_path.read_text())
    if sys.platform != provider["platform"] or platform.machine() != provider["architecture"]:
        raise ValueError("Wrong native provider environment")
    destination = Path(sys.argv[1])
    destination.mkdir(parents=True, exist_ok=False)
    expected_url = ("https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/"
                    f"claude-code-linux-x64-{provider['version']}.tgz")
    if provider["tarball"] != expected_url:
        raise ValueError("Wrong characterization provider registry")
    with urllib.request.urlopen(expected_url, timeout=60) as response:
        if response.url != expected_url:
            raise ValueError("Characterization provider download redirected")
        raw = response.read()
    (destination / "provider.tgz").write_bytes(raw)
    binary = binary_from_archive(raw, provider)
    executable = destination / "claude"
    executable.write_bytes(binary)
    executable.chmod(0o755)
    receipt = {"schema": "paperclip.characterization-provider.v1", "provider": provider,
               "provider_policy_sha256": hashlib.sha256(provider_path.read_bytes()).hexdigest(),
               "archive_sha256": hashlib.sha256(raw).hexdigest(),
               "binary_sha256": hashlib.sha256(binary).hexdigest(), "installer_scripts_executed": False}
    (destination / "provider.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
