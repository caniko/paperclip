import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRunnerdCodexTransport } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import {
  registerRunnerPrpAuthority,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const runnerWorkspace = resolve(
  import.meta.dirname,
  "../../../../packages/paperclip-runner/runner",
);
const executableSuffix = process.platform === "win32" ? ".exe" : "";

describe("paperclip-runner real server vertical slice", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let runnerBinary: string;
  let fakeCodexAppServer: string;
  const companyId = "00000000-0000-4000-8000-000000000701";
  const agentId = "00000000-0000-4000-8000-000000000702";
  const issueId = "00000000-0000-4000-8000-000000000703";
  const runId = "00000000-0000-4000-8000-000000000704";
  const resumedRunId = "00000000-0000-4000-8000-000000000705";

  beforeAll(async () => {
    // Build even when binaries exist so the fixture exercises fresh source.
    execFileSync("cargo", [
      "build",
      "--release",
      "--locked",
      "-p",
      "paperclip-runner-core",
      "--bin",
      "paperclip-runnerd",
      "--bin",
      "fake-codex-app-server",
    ], {
      cwd: runnerWorkspace,
      stdio: "inherit",
      timeout: 600_000,
    });

    // Resolve the same target directory Cargo used, including toolchain
    // environment and config overrides (see stage-runner-binary.mjs).
    const metadata: unknown = JSON.parse(execFileSync("cargo", [
      "metadata",
      "--format-version=1",
      "--no-deps",
      "--locked",
      "--offline",
    ], {
      cwd: runnerWorkspace,
      encoding: "utf8",
    }));
    if (
      !metadata || typeof metadata !== "object" ||
      !("target_directory" in metadata) ||
      typeof metadata.target_directory !== "string" ||
      !isAbsolute(metadata.target_directory)
    ) {
      throw new Error("Cargo metadata must contain an absolute target_directory");
    }
    runnerBinary = resolve(metadata.target_directory, "release", `paperclip-runnerd${executableSuffix}`);
    fakeCodexAppServer = resolve(metadata.target_directory, "release", `fake-codex-app-server${executableSuffix}`);
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-runner-real-server-");
  }, 660_000);

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await temporary?.cleanup();
  });

  it("runs Rust runnerd through Paperclip PRP and reads the real bound task", async () => {
    const db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Real runner slice", issuePrefix: "RRS" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Real runner agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RRS-1",
      title: "Read me through the real control plane",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
    setupRunnerPrpWebSocketServer(server, {
      apiUrl: `http://127.0.0.1:${address.port}`,
    });
    const stateDirectory = await mkdtemp(resolve(tmpdir(), "paperclip-runner-real-resume-"));
    const expectedContextFile = resolve(stateDirectory, "expected-context.json");
    await writeFile(expectedContextFile, JSON.stringify({ companyId, actorId: agentId, taskId: issueId, runId, callId: "semantic-call-1" }));
    const fakeArgs = ["--state-file", resolve(stateDirectory, "fake-provider-state.json"), "--emit-tool-call", "--durable-turn-ids", "--durable-tool-ids", "--expected-canonical-task-context-file", expectedContextFile];
    const bundle = createRunnerdCodexTransport({
      runnerBinary,
      codexCommand: fakeCodexAppServer,
      codexArgs: fakeArgs,
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: {
        runnerInstanceId: "runner-real-server",
        environmentLeaseId: "lease-real-server",
        runId,
        normalizedSessionId: "session-real-server",
        turnId: "turn-real-server",
        itemId: "item-real-server",
      },
      controlPlaneRegistration: (prp) => registerRunnerPrpAuthority({ companyId, runId, authority: prp }),
    });
    const observedResults: unknown[] = [];
    bundle.transport.setServerRequestHandler(async (request) => {
      const params = request.params as Record<string, unknown>;
      const result = await authority.execute({
        tool: String(params.tool),
        callId: String(params.callId),
        arguments: params.arguments,
      });
      observedResults.push(result);
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, operationId: params.tool, callId: params.callId, value: result }) }],
      };
    });

    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: await authority.definitions(),
      });
      await bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "Read your assigned task context." }],
      });
      for await (const notification of bundle.transport.notifications()) {
        if (notification.method === "turn/completed") break;
      }
      expect(observedResults).toHaveLength(1);
      expect(observedResults[0]).toMatchObject({
        activeTask: { id: issueId, identifier: "RRS-1", title: "Read me through the real control plane" },
        actor: { id: agentId },
        run: { id: runId },
      });
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");

      await bundle.transport.close();
      await db.insert(heartbeatRuns).values({
        id: resumedRunId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        invocationSource: "assignment",
        triggerDetail: "system",
        contextSnapshot: { issueId },
      });
      await db.update(issues).set({ executionRunId: resumedRunId }).where(eq(issues.id, issueId));
      const resumedAuthority = new PaperclipRunnerToolAuthority(db, {
        companyId,
        agentId,
        issueId,
        runId: resumedRunId,
      });
      await writeFile(expectedContextFile, JSON.stringify({ companyId, actorId: agentId, taskId: issueId, runId: resumedRunId, callId: "semantic-call-2" }));
      const restored = createRunnerdCodexTransport({
        runnerBinary,
        codexCommand: fakeCodexAppServer,
        codexArgs: fakeArgs,
        stateDirectory,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        resumeDynamicTools: await resumedAuthority.definitions(),
        prpIdentity: {
          runnerInstanceId: "runner-real-server",
          environmentLeaseId: "lease-real-server",
          runId: resumedRunId,
          normalizedSessionId: "session-real-server",
          turnId: "turn-real-server-resumed",
          itemId: "item-real-server-resumed",
        },
        controlPlaneRegistration: (prp) => registerRunnerPrpAuthority({
          companyId,
          runId: resumedRunId,
          authority: prp,
        }),
      });
      restored.transport.setServerRequestHandler(async (request) => {
        const params = request.params as Record<string, unknown>;
        const result = await resumedAuthority.execute({
          tool: String(params.tool),
          callId: String(params.callId),
          arguments: params.arguments,
        });
        observedResults.push(result);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, operationId: params.tool, callId: params.callId, value: result }) }],
        };
      });
      try {
        await restored.transport.request("thread/read", {});
        await restored.transport.request("turn/start", {
          input: [{ type: "text", text: "Read the same task in a resumed process." }],
        });
        for await (const notification of restored.transport.notifications()) {
          if (notification.method === "turn/completed") break;
        }
        expect(observedResults).toHaveLength(2);
        expect(observedResults[1]).toMatchObject({
          activeTask: { id: issueId, identifier: "RRS-1" },
          run: { id: resumedRunId },
        });
        expect(restored.evidence().diagnostics).toContain(
          "runnerd attached the durable provider session to a fresh PRP run authority",
        );
      } finally {
        await restored.transport.close();
      }
    } finally {
      await bundle.transport.close();
      await rm(stateDirectory, { recursive: true, force: true });
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});
