import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { reconcileExecution } from "./recovery.js";

it.each(["completed", "uncertain", "stop"])(
  "follows approved successors and retains durable ownership: %s",
  async (mode) => {
    const cancel = new AbortController();
    const checkpoints: Record<string, unknown>[] = [];
    const progress: Record<string, unknown>[] = [];
    const events: AdapterRuntimeEvent[] = [];
    const stopped = vi.fn(async () => {});
    let parentObserved = false,
      leafStreams = 0,
      allowSettlement = false,
      returned = false,
      stops = 0;
    const cursors: (string | undefined)[] = [];
    const frame = (run: string, sequence: number, event: string, fields = {}) =>
      `id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify({ run_id: run, sequence, event, ...fields })}\n\n`;
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/capabilities") {
        res.end(
          JSON.stringify({
            features: {
              runs_recovery: {
                version: 1,
                durable_lineage_stop: true,
                ordinary_stop_admission: true,
              },
            },
          }),
        );
      } else if (req.url === "/v1/runs") {
        expect(checkpoints).toHaveLength(1);
        let body = "";
        for await (const chunk of req) body += chunk;
        expect(body).toBe(checkpoints[0].body);
        res.end(JSON.stringify({ run_id: "parent", status: "started" }));
      } else if (req.url === "/v1/runs/parent/events") {
        parentObserved = true;
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          frame("parent", 1, "message.delta", { delta: "parent " }) +
            frame("parent", 2, "run.superseded", { successor_run_id: "leaf" }),
        );
      } else if (req.url === "/v1/runs/parent") {
        res.end(
          JSON.stringify({
            run_id: "parent",
            status: parentObserved ? "superseded" : "running",
            ...(parentObserved ? { successor_run_id: "leaf" } : {}),
          }),
        );
      } else if (req.url === "/v1/runs/leaf/events") {
        cursors.push(req.headers["last-event-id"] as string | undefined);
        leafStreams++;
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          frame("leaf", 1, "message.delta", { delta: "leaf " }) +
            (leafStreams > 1 && mode !== "stop"
              ? frame(
                  "leaf",
                  2,
                  mode === "uncertain" ? "run.unrecoverable" : "run.completed",
                  mode === "uncertain"
                    ? { intervention_reason: "tool_effect_uncertain" }
                    : { output: "recovered final" },
                )
              : ""),
        );
      } else if (req.url === "/v1/runs/leaf") {
        res.end(JSON.stringify({ run_id: "leaf", status: "running" }));
      } else if (
        req.url === "/v1/runs/parent/stop" ||
        req.url === "/v1/runs/stop"
      ) {
        stops++;
        if (req.url === "/v1/runs/stop") {
          let body = "";
          for await (const chunk of req) body += chunk;
          expect(body).toBe(checkpoints[0].body);
        }
        res.end(
          JSON.stringify({
            run_id: "parent",
            status: "superseded",
            stop_requested: true,
            lineage_settled: allowSettlement,
            lineage: [
              { run_id: "parent", status: "superseded" },
              {
                run_id: "leaf",
                status: allowSettlement ? "cancelled" : "stopping",
              },
            ],
          }),
        );
      } else res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const execution = execute({
      runId: "paperclip-lineage",
      signal: cancel.signal,
      agent: {
        id: "agent",
        companyId: "company",
        name: "Worker",
        adapterType: "hermes_gateway",
        adapterConfig: {},
      },
      config: {
        apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: "fixture",
        pollIntervalMs: 250,
        eventReconnectMs: 250,
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      context: {},
      onLog: async () => {},
      onEvent: async (event) => {
        events.push(event);
      },
      onExecutionCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
      onExecutionProgress: async (update) => {
        progress.push(update);
      },
      onProviderStopped: stopped,
    }).then((result) => {
      returned = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(leafStreams).toBeGreaterThan(0), {
        timeout: 5000,
      });
      if (mode === "stop") {
        cancel.abort();
        await vi.waitFor(() => expect(stops).toBeGreaterThan(1), {
          timeout: 5000,
        });
        expect(returned).toBe(false);
        expect(stopped).not.toHaveBeenCalled();
        expect(await reconcileExecution(checkpoints[0])).toBe("pending");
        allowSettlement = true;
      }
      const result = await execution;
      expect(checkpoints).toHaveLength(1);
      expect(
        progress.some(
          (update) =>
            update.runId === "leaf" &&
            JSON.stringify(update.lineage) === '["parent","leaf"]',
        ),
      ).toBe(true);
      expect(
        events.filter(
          (event) =>
            (event.providerSource as { runId: string; sequence: number })
              .runId === "leaf" &&
            (event.providerSource as { sequence: number }).sequence === 1,
        ),
      ).toHaveLength(1);
      if (mode !== "stop")
        expect(cursors.slice(0, 2)).toEqual([undefined, "1"]);
      expect(result.resultJson?.run_id).toBe("leaf");
      expect(result.errorCode).toBe(
        mode === "uncertain"
          ? "hermes_gateway_tool_effect_uncertain"
          : mode === "stop"
            ? "hermes_gateway_cancelled"
            : undefined,
      );
      if (mode === "uncertain")
        expect(result.resultJson?.intervention_reason).toBe(
          "tool_effect_uncertain",
        );
      if (mode === "completed") expect(result.summary).toBe("recovered final");
      expect(stopped).toHaveBeenCalledOnce();
      allowSettlement = true;
      expect(await reconcileExecution(checkpoints[0])).toBe("settled");
    } finally {
      allowSettlement = true;
      cancel.abort();
      await execution;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15_000,
);
