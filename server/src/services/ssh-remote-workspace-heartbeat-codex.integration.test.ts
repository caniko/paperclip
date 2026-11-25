import { describe, it } from "vitest";
import { selectSshHeartbeatRuns, sshHeartbeatCase, sshWorkspaceTestsSupported, useSshWorkspaceFixture } from "./__tests__/ssh-remote-workspace-fixture.js";

describe.skipIf(!sshWorkspaceTestsSupported)("Cloud SSH heartbeat runs for codex_local with a real SSH server", () => {
  const fixture = useSshWorkspaceFixture("cloud-ssh-heartbeat-");
  it.each(selectSshHeartbeatRuns({ include: ["codex_local"] }))("runs an assigned $key task through heartbeat over SSH", sshHeartbeatCase(fixture), 60_000);
});
