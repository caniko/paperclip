import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import { resolvePaperclipInstanceId } from "@paperclipai/shared/home-paths";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { exerciseMcpProofBackpressure } from "./helpers/mcp-proof-backpressure.js";
import { mcpWorkerEnrollmentService } from "../services/mcp-worker-enrollment.js";
import { mcpWorkerEnrollmentProofBytes } from "../services/mcp-worker-enrollment-contract.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

describe("worker proof through the complete application", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  let createApp: typeof import("../app.js").createApp, logger: typeof import("../middleware/logger.js").logger;
  const apps = new Set<Awaited<ReturnType<typeof createApp>>>();
  const controllerInstanceId = "proof-qualification-controller";
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-mcp-ingress-app-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-ingress-app-db-");
    db = createDb(database.connectionString);
    ({ createApp } = await import("../app.js"));
    ({ logger } = await import("../middleware/logger.js"));
  }, 60_000);
  afterEach(async () => {
    for (const app of apps) await app.locals.paperclipShutdown();
    apps.clear();
    vi.restoreAllMocks();
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }, 60_000);

  async function fixture(instanceId = controllerInstanceId) {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const app = await createApp(db, { uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "authenticated", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false, instanceId, managedPluginAutoInstall: [],
      localPluginDir: join(root, "plugins"), decisionServiceOptions: { wakeOriginAgent: async () => undefined }, resolveSession });
    apps.add(app);
    return { app, resolveSession, client: request.agent(app).set("Host", "127.0.0.1") };
  }

  async function enrollment() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Proof qualification", issuePrefix: companyId.slice(0, 8) });
    const preparation = await mcpWorkerEnrollmentService(db, { controllerInstanceId }).prepare(companyId, {
      workerId: "fixture-worker", keyId: "fixture-key", publicKey, gatewayUrl: "https://worker.example/api",
      executionHostId: "fixture-host", expiresAt: Date.now() + 60_000,
    }, { actorType: "user", actorId: "fixture-operator" });
    const signature = sign(null, mcpWorkerEnrollmentProofBytes(preparation.challenge), key.privateKey).toString("base64url");
    return { ...preparation, companyId, signature, path: `/mcp/worker-enrollments/${preparation.enrollment.id}/proof` };
  }

  it("uses the configured controller and commits one real acceptance audit across concurrent HTTP retries", async () => {
    const f = await fixture(), proof = await enrollment();
    const responses = await Promise.all([0, 1].map(() => f.client.post(proof.path).set("Authorization", `Bearer ${proof.bearerToken}`).send({ signature: proof.signature })));
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(responses[0].body.controllerInstanceId).toBe(controllerInstanceId);
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, proof.enrollment.id));
    expect(events.map(event => event.action)).toEqual(["mcp_worker.enrollment_prepared", "mcp_worker.enrolled"]);
    expect(f.resolveSession).not.toHaveBeenCalled();
  });

  it("rejects an unterminated private proof before global parsing/logging/actor handling", async () => {
    const f = await fixture(), proof = await enrollment();
    const sink = (logger as unknown as Record<symbol, Writable>)[pino.symbols.streamSym];
    const writes = vi.spyOn(sink, "write");
    // A declared length larger than the provided private bytes never completes.
    // A normal global parser would wait; the early credential check must reply.
    const response = await f.client.post(proof.path).set("Authorization", `Bearer pcmwe_${"A".repeat(43)}`)
      .set("Content-Type", "application/json").set("Content-Length", "1000").send('{"private":"PRIVATE-UNTERMINATED-SENTINEL"');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("runtime_mcp_admission_blocked");
    expect(response.text).not.toContain("PRIVATE-UNTERMINATED-SENTINEL");
    expect(f.resolveSession).not.toHaveBeenCalled();
    // An unmatched ordinary API request still authenticates and logs normally.
    expect((await f.client.get("/api/companies")).status).toBe(403);
    expect(f.resolveSession).toHaveBeenCalledOnce();
    const bytes = writes.mock.calls.map(call => String(call[0])).join("\n");
    expect(bytes).toContain("/api/companies");
    expect(bytes).not.toContain("PRIVATE-UNTERMINATED-SENTINEL");
    expect(bytes).not.toContain(proof.bearerToken);
    expect(bytes).not.toContain(proof.path);
    expect((await f.client.get("/api/health")).status).toBe(200);
    for (const path of [proof.path + "/", "/api" + proof.path]) {
      const response = await f.client.post(path).set("Authorization", `Bearer ${proof.bearerToken}`).send({ signature: proof.signature });
      expect(response.status).toBe(401);
      expect(response.body.error).not.toEqual(expect.objectContaining({ code: "runtime_mcp_admission_blocked" }));
    }
    expect((await mcpWorkerEnrollmentService(db, { controllerInstanceId }).inspect(proof.companyId, proof.enrollment.id))?.state).toBe("pending");
  });

  it("starts normally with a valid 129-character instance ID while blocking MCP enrollment proof", async () => {
    const instanceId = "a".repeat(129);
    expect(resolvePaperclipInstanceId(instanceId)).toBe(instanceId);
    const f = await fixture(instanceId), proof = await enrollment();
    expect((await f.client.get("/api/health")).status).toBe(200);
    expect((await f.client.get("/api/companies")).status).toBe(403);
    const response = await f.client.post(proof.path).set("Authorization", `Bearer ${proof.bearerToken}`).send({ signature: proof.signature });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("runtime_mcp_admission_blocked");
  });

  it("hard-closes response backpressure through actual createApp and settles the accepted proof", async () => {
    const f = await fixture(), proof = await enrollment();
    const outcome = await exerciseMcpProofBackpressure(f.app, proof, 35_000);
    expect(outcome).toEqual({ backpressured: true, serverSocketDestroyed: true });
    expect((await mcpWorkerEnrollmentService(db, { controllerInstanceId }).inspect(proof.companyId, proof.enrollment.id))?.state).toBe("enrolled");
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, proof.enrollment.id));
    expect(events.filter(event => event.action === "mcp_worker.enrolled")).toHaveLength(1);
    expect(f.resolveSession).not.toHaveBeenCalled();
  }, 45_000);
});
