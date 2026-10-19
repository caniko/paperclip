import { expect, it } from "vitest";
import { adapterExecutionTargetSessionMatches } from "@paperclipai/adapter-utils/execution-target";
import { sessionCodec } from "./index.js";

it("retains managed backend affinity without persisting admission credentials", () => {
  const params = { sessionId: "ses_external_owned", cwd: "/work", managedBackendID: "backend-1" };
  expect(
    sessionCodec.deserialize(
      JSON.parse(
        JSON.stringify(
          sessionCodec.serialize({
            ...params,
            body: "private admission",
            environment: { PAPERCLIP_API_KEY: "private token" },
          }),
        ),
      ),
    ),
  ).toEqual(params);
  expect(sessionCodec.deserialize({ ...params, managedBackendID: 1 })).toBeNull();
  expect(sessionCodec.deserialize({ ...params, managedBackendID: "" })).toBeNull();
});

it("retains SSH resume identity through the persisted codec without credentials", () => {
  const spec = {
    host: "atlas",
    port: 1337,
    username: "can",
    remoteCwd: "/work",
    remoteWorkspacePath: "/work",
    privateKey: "PRIVATE",
    knownHosts: "HOST KEY",
    strictHostKeyChecking: true,
  };
  const saved = sessionCodec.deserialize(
    JSON.parse(
      JSON.stringify(
        sessionCodec.serialize({
          sessionId: "ses_owned",
          cwd: "/work",
          workspaceId: "workspace",
          remoteExecution: { transport: "ssh", ...spec },
        }),
      ),
    ),
  );
  expect(saved).toMatchObject({ sessionId: "ses_owned", workspaceId: "workspace" });
  expect(
    adapterExecutionTargetSessionMatches(saved?.remoteExecution, {
      kind: "remote",
      transport: "ssh",
      spec,
      remoteCwd: "/work",
    }),
  ).toBe(true);
  expect(JSON.stringify(saved)).not.toMatch(/PRIVATE|HOST KEY/);
  expect(
    adapterExecutionTargetSessionMatches(saved?.remoteExecution, {
      kind: "remote",
      transport: "ssh",
      spec: { ...spec, host: "nomad" },
      remoteCwd: "/work",
    }),
  ).toBe(false);
});

it("retains sandbox lease identity and rejects malformed remote bindings", () => {
  const remoteExecution = {
    transport: "sandbox",
    providerKey: "daytona",
    environmentId: "env",
    leaseId: "lease",
    remoteCwd: "/work",
  };
  expect(sessionCodec.deserialize(sessionCodec.serialize({ sessionId: "ses_owned", remoteExecution }))).toEqual({
    sessionId: "ses_owned",
    remoteExecution,
  });
  expect(sessionCodec.deserialize({ sessionId: "ses_owned", remoteExecution: { transport: "ssh" } })).toBeNull();
  expect(sessionCodec.deserialize({ session_id: "ses_legacy", workdir: "/legacy" })).toEqual({
    sessionId: "ses_legacy",
    cwd: "/legacy",
  });
});
