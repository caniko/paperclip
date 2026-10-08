import { createServer, request } from "node:http";
import { describe, expect, it } from "vitest";
import { createRunnerFixtureHttpTracker } from "./helpers/runner-api-server.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("runner fixture HTTP settlement", () => {
  for (const disconnect of [false, true]) {
    it(disconnect ? "refuses reset after a client abort while its route keeps working"
      : "waits for a route's final writes and response before allowing reset", async () => {
      const tracker = createRunnerFixtureHttpTracker();
      const started = latch(), release = latch(), routeDone = latch(), closed = latch();
      let committed = false;
      const server = createServer((req, res) => tracker.dispatch(req, res, (_req, res) => {
        res.once("close", closed.release);
        void (async () => {
          started.release();
          await release.promise;
          committed = true;
          res.end("done");
          routeDone.release();
        })();
      }));
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      const client = request(`http://127.0.0.1:${address.port}`);
      client.on("error", () => {});
      client.on("response", res => res.resume());
      client.end();
      try {
        await started.promise;
        if (disconnect) {
          client.destroy();
          await closed.promise;
          await expect(tracker.stopAndDrain()).rejects.toThrow("HTTP work did not establish settlement");
          expect(committed).toBe(false);
          release.release();
          await routeDone.promise;
          await expect(tracker.stopAndDrain()).rejects.toThrow("HTTP work did not establish settlement");
        } else {
          let settled = false;
          const drain = tracker.stopAndDrain().then(() => { settled = true; });
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(committed).toBe(false);
          release.release();
          await drain;
          expect(committed).toBe(true);
        }
      } finally {
        release.release();
        await routeDone.promise;
        client.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
    });
  }
});
