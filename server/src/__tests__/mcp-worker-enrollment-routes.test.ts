import express from "express";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpWorkerEnrollment } from "@paperclipai/shared";
import { mcpWorkerEnrollmentProofRoutes } from "../routes/mcp-worker-enrollment.js";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";
import { exerciseMcpProofBackpressure } from "./helpers/mcp-proof-backpressure.js";

const enrollmentId = "11111111-1111-4111-8111-111111111111";
const endpoint = `/mcp/worker-enrollments/${enrollmentId}/proof`;
const bearerToken = `pcmwe_${Buffer.alloc(32, 9).toString("base64url")}`;
const signature = Buffer.alloc(64).toString("base64url");
const receipt: McpWorkerEnrollment = { id: enrollmentId, companyId: enrollmentId, controllerInstanceId: "fixture",
  workerId: "worker", keyId: "key", publicKey: "public-key", gatewayUrl: "https://worker.example/api",
  executionHostId: "host", state: "enrolled", revision: enrollmentId, createdAt: 1, enrolledAt: 2, revokedAt: null, expiresAt: 3 };
const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  servers.clear();
  vi.restoreAllMocks();
});

function fixture(limits = {}) {
  const service = { authenticateBootstrap: vi.fn().mockResolvedValue(undefined), prove: vi.fn().mockResolvedValue(receipt) };
  const downstream = vi.fn();
  const app = express();
  app.set("trust proxy", false);
  app.use(mcpWorkerEnrollmentProofRoutes(service, privateHostnameGuard({ enabled: true, allowedHostnames: [], bindHost: "127.0.0.1" }), limits));
  app.use(express.json());
  app.use((req, res) => { downstream(req.body); res.status(418).json({ ordinaryActorPath: true }); });
  // Supertest binds on an unspecified address; explicitly use an approved Host
  // so the hostname guard doesn't mask the authentication/body assertions.
  const client = request.agent(app).set("Host", "127.0.0.1");
  return { app, service, downstream, client };
}

async function rawUpload(app: express.Express, body: string, headers: string[] = []) {
  const server = createServer(app);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const socket = connect(port, "127.0.0.1");
  const response = new Promise<string>((resolve, reject) => {
    let bytes = "";
    socket.on("data", data => { bytes += data.toString(); });
    socket.on("error", error => { if (bytes) resolve(bytes); else reject(error); });
    socket.on("close", () => resolve(bytes));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Bounded ingress did not close the upload")); });
  });
  await once(socket, "connect");
  socket.write([`POST ${endpoint} HTTP/1.1`, "Host: 127.0.0.1", `Authorization: Bearer ${bearerToken}`,
    "Content-Type: application/json", "Transfer-Encoding: chunked", ...headers, "", body].join("\r\n"));
  // Intentionally no terminating chunk: rejection cannot await upload drainage.
  return { response, socket };
}

describe("exact bootstrap-authenticated worker proof ingress", () => {
  it("authenticates before parsing and reauthorizes the signature in the mutation service", async () => {
    const f = fixture();
    const response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(receipt);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.service.authenticateBootstrap).toHaveBeenCalledWith({ enrollmentId, bearerToken });
    expect(f.service.prove).toHaveBeenCalledWith({ enrollmentId, bearerToken, signature });
    expect(f.service.authenticateBootstrap.mock.invocationCallOrder[0]).toBeLessThan(f.service.prove.mock.invocationCallOrder[0]);
    expect(f.downstream).not.toHaveBeenCalled();
  });

  it.each(["", "Bearer board-key", "Bearer pcgw_run-token", "Bearer agent-key", "Basic operator", `Bearer ${bearerToken},another`])(
    "rejects non-bootstrap Authorization %s before the malformed body or ordinary actor path", async authorization => {
      const f = fixture();
      const response = await f.client.post(endpoint).set("Authorization", authorization).set("Cookie", "board_session=operator")
        .set("Content-Type", "application/json").send('{"private":"PRIVATE-PAYLOAD"');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("runtime_mcp_admission_blocked");
      expect(response.text).not.toContain("PRIVATE-PAYLOAD");
      expect(f.service.authenticateBootstrap).not.toHaveBeenCalled();
      expect(f.service.prove).not.toHaveBeenCalled();
      expect(f.downstream).not.toHaveBeenCalled();
    });

  it("rejects duplicate Authorization fields and query credentials before database access", async () => {
    const f = fixture({ deadlineMs: 200 });
    const raw = await rawUpload(f.app, "", [`authorization: Bearer ${bearerToken}`]);
    expect(await raw.response).toContain("403 Forbidden");
    const query = await f.client.post(`${endpoint}?token=PRIVATE-QUERY`).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(query.status).toBe(403);
    expect(query.text).not.toContain("PRIVATE-QUERY");
    expect(f.service.authenticateBootstrap).not.toHaveBeenCalled();
    expect(f.downstream).not.toHaveBeenCalled();
  });

  it.each(["get", "put", "delete"] as const)("keeps %s proof requests on the ordinary middleware path", async method => {
    const f = fixture();
    const response = await f.client[method](endpoint).set("Authorization", `Bearer ${bearerToken}`);
    expect(response.status).toBe(418);
    expect(f.service.authenticateBootstrap).not.toHaveBeenCalled();
    expect(f.downstream).toHaveBeenCalledOnce();
  });

  it.each([`${endpoint}/`, `${endpoint}/next`, `/api${endpoint}`, endpoint.replace(enrollmentId, "not-an-enrollment")])(
    "keeps unmatched %s on the ordinary middleware path", async path => {
      const f = fixture();
      expect((await f.client.post(path).send({ signature })).status).toBe(418);
      expect(f.service.authenticateBootstrap).not.toHaveBeenCalled();
      expect(f.downstream).toHaveBeenCalledOnce();
    });

  it("enforces the existing hostname gate before authentication", async () => {
    const f = fixture();
    const response = await f.client.post(endpoint).set("Host", "unapproved.example").set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.service.authenticateBootstrap).not.toHaveBeenCalled();
    expect(f.downstream).not.toHaveBeenCalled();
  });

  it.each(['{"signature":', JSON.stringify({ signature, executionHostId: "self-asserted" }), JSON.stringify({ signature: "not-canonical" }), "null"])(
    "rejects malformed/authority-bearing proof body without forwarding it", async body => {
      const f = fixture();
      const response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).set("Content-Type", "application/json").send(body);
      expect(response.status).toBe(403);
      expect(f.service.prove).not.toHaveBeenCalled();
      expect(f.downstream).not.toHaveBeenCalled();
    });

  it("rejects compressed or declared oversized bodies before authentication", async () => {
    const f = fixture();
    const compressed = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).set("Content-Encoding", "gzip").send({ signature });
    expect(compressed.status).toBe(403);
    const large = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature, private: "x".repeat(1100) });
    expect(large.status).toBe(403);
    expect(f.service.authenticateBootstrap).not.toHaveBeenCalled();
    expect(f.service.prove).not.toHaveBeenCalled();
  });

  it.each(["500\r\n" + "x".repeat(1280) + "\r\n", "1\r\n{\r\n"])(
    "closes an unterminated oversized/stalled upload within the total deadline", async body => {
      const f = fixture({ deadlineMs: 100 });
      const upload = await rawUpload(f.app, body);
      expect(await upload.response).toContain("403 Forbidden");
      expect(f.service.prove).not.toHaveBeenCalled();
      expect(f.downstream).not.toHaveBeenCalled();
    });

  it("holds the non-queueing concurrency permit until timed-out database work settles", async () => {
    const f = fixture({ deadlineMs: 100, inFlight: 1 });
    let settle!: () => void;
    f.service.authenticateBootstrap.mockImplementationOnce(() => new Promise<void>(resolve => { settle = resolve; }));
    const response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(403);
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature })).status).toBe(429);
    expect(f.service.authenticateBootstrap).toHaveBeenCalledOnce();
    settle();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature })).status).toBe(200);
    expect(f.service.prove).toHaveBeenCalledOnce();
  });

  it("rejects raw forwarded-IP attempt-budget spoofing", async () => {
    const f = fixture({ requestsPerWindow: 1, clientKeys: 1 });
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).set("X-Forwarded-For", "198.51.100.1").send({ signature })).status).toBe(200);
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).set("X-Forwarded-For", "198.51.100.2").send({ signature })).status).toBe(429);
    expect(f.service.authenticateBootstrap).toHaveBeenCalledOnce();
  });

  it("fails closed when the trusted client-key budget is full", async () => {
    const f = fixture({ clientKeys: 1 });
    f.app.set("trust proxy", "loopback");
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).set("X-Forwarded-For", "198.51.100.1").send({ signature })).status).toBe(200);
    const refused = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).set("X-Forwarded-For", "198.51.100.2").send({ signature });
    expect(refused.status).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(f.service.authenticateBootstrap).toHaveBeenCalledOnce();
  });

  it("does not receive a body while authentication is unresolved and settles disconnect before releasing capacity", async () => {
    const f = fixture({ deadlineMs: 500, inFlight: 1 });
    let settle!: () => void, entered!: () => void;
    const authenticating = new Promise<void>(resolve => { entered = resolve; });
    f.service.authenticateBootstrap.mockImplementationOnce(() => { entered(); return new Promise<void>(resolve => { settle = resolve; }); });
    const upload = await rawUpload(f.app, "1\r\n{\r\n");
    await authenticating;
    upload.socket.destroy();
    await upload.response;
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature })).status).toBe(429);
    expect(f.service.prove).not.toHaveBeenCalled();
    settle();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature })).status).toBe(200);
  });

  it("retains the mutation permit after its HTTP deadline until the actual proof transaction settles", async () => {
    const f = fixture({ deadlineMs: 100, inFlight: 1 });
    let settle!: (value: McpWorkerEnrollment) => void;
    f.service.prove.mockImplementationOnce(() => new Promise<McpWorkerEnrollment>(resolve => { settle = resolve; }));
    const response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(403);
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature })).status).toBe(429);
    expect(f.service.prove).toHaveBeenCalledOnce();
    settle(receipt);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature })).status).toBe(200);
  });

  it.each([false, true])("hard-closes a backpressured queued proof response (rejected: %s)", async rejected => {
    const f = fixture({ deadlineMs: 100 });
    if (rejected) f.service.authenticateBootstrap.mockRejectedValueOnce(new Error("Private bootstrap rejection"));
    const outcome = await exerciseMcpProofBackpressure(f.app, { path: endpoint, bearerToken, signature });
    expect(outcome).toEqual({ backpressured: true, serverSocketDestroyed: true });
    expect(f.service.prove).toHaveBeenCalledTimes(rejected ? 0 : 1);
  });

  it("checks elapsed monotonic time before proof even if the deadline callback is delayed", async () => {
    const f = fixture({ deadlineMs: 100 });
    const clock = vi.spyOn(performance, "now").mockReturnValue(1);
    f.service.authenticateBootstrap.mockImplementationOnce(async () => { clock.mockReturnValue(1001); });
    const response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(403);
    expect(f.service.prove).not.toHaveBeenCalled();
  });

  it("contains preauth and postauth failures without exposing database error bytes", async () => {
    const f = fixture();
    f.service.authenticateBootstrap.mockRejectedValueOnce(new Error("PRIVATE-DB-TOKEN"));
    let response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("PRIVATE-DB-TOKEN");
    f.service.prove.mockRejectedValueOnce(new Error("PRIVATE-REVOKED-AUTHORITY"));
    response = await f.client.post(endpoint).set("Authorization", `Bearer ${bearerToken}`).send({ signature });
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("PRIVATE-REVOKED-AUTHORITY");
    expect(f.downstream).not.toHaveBeenCalled();
  });
});
