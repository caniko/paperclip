import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { execute } from "./execute.js";
import { reconcileExecution } from "./recovery.js";

it("keeps uncertain admission, events and recovery on the selected worker with the original wire body", async () => {
  let creates = 0;
  const paths: string[] = [];
  const checkpoints: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    if (req.headers.authorization !== "Bearer fixture") return res.writeHead(401).end();
    if (req.url?.endsWith("/v1/capabilities")) {
      res.end(JSON.stringify({ features: {
        runs_executor_admission: { version: 1, accepting: true,
          available_slots: req.url.startsWith("/atlas") && creates === 0 ? 0 : 1 },
        runs_recovery: { version: 1, durable_lineage_stop: true, ordinary_stop_admission: true, admission_binding: 1 },
      } }));
    } else if (req.url === "/nomad/v1/runs" || req.url === "/nomad/v1/runs/stop") {
      let body = "";
      for await (const chunk of req) body += chunk;
      expect(checkpoints).toHaveLength(1);
      expect(body).toBe(checkpoints[0]!.body);
      expect(req.headers["idempotency-key"]).toBe("fleet-run");
      if (req.url === "/nomad/v1/runs" && ++creates === 1) {
        req.socket.destroy(); // Lost acceptance: the primary becomes ready now.
        return;
      }
      res.end(JSON.stringify(req.url.endsWith("/stop") ? {
        run_id: "root", status: "completed", stop_requested: true, lineage_settled: true,
        lineage: [{ run_id: "root", status: "completed" }],
        admission: { version: 1, root_run_id: "root",
          key_sha256: createHash("sha256").update("fleet-run").digest("hex"),
          body_sha256: createHash("sha256").update(body).digest("hex") },
      } : { run_id: "root", status: "running" }));
    } else if (req.url === "/nomad/v1/runs/root/events") {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`id: 1\nevent: run.completed\ndata: ${JSON.stringify({
        run_id: "root", sequence: 1, event: "run.completed", status: "completed", output: "settled",
      })}\n\n`);
    } else if (req.url === "/nomad/v1/runs/root") {
      res.end(JSON.stringify({ run_id: "root", status: "completed", output: "settled" }));
    } else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await execute({
      runId: "fleet-run", agent: { id: "agent", companyId: "company", name: "Worker", adapterType: "hermes_gateway", adapterConfig: {} },
      config: { apiBaseUrl: `${origin}/atlas`, executorEndpoints: [`${origin}/atlas`, `${origin}/nomad`],
        apiKey: "fixture", pollIntervalMs: 250, eventReconnectMs: 250, timeoutSec: 5 },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      context: {}, onLog: async () => {},
      onExecutionCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
      onExecutionProgress: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams?.executorBaseUrl).toBe(`${origin}/nomad`);
    expect(checkpoints[0]?.baseUrl).toBe(`${origin}/nomad`);
    expect(creates).toBe(2);
    expect(await reconcileExecution(checkpoints[0]!)).toBe("settled");
    expect(paths.filter((path) => path.startsWith("/atlas"))).toEqual(["/atlas/v1/capabilities"]);
    expect(paths).toContain("/nomad/v1/runs/stop");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
