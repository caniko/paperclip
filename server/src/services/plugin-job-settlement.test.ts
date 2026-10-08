import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, pluginJobs, pluginJobRuns, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import { createPluginJobCoordinator } from "./plugin-job-coordinator.js";
import { pluginJobStore } from "./plugin-job-store.js";
import { pluginLifecycleManager } from "./plugin-lifecycle.js";
import { createPluginWorkerManager } from "./plugin-worker-manager.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("plugin work settlement before fixture disposal", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-plugin-settlement-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);
  afterEach(async () => { await db.delete(plugins); });

  async function seed() {
    const pluginId = randomUUID(), jobId = randomUUID();
    const manifest: PaperclipPluginManifestV1 = { id: `settlement-${pluginId}`, apiVersion: 1,
      version: "1.0.0", displayName: "Settlement fixture", description: "Fixture", author: "Fixture", categories: [], capabilities: [],
      entrypoints: { worker: "worker.js" } };
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id,
      packageName: manifest.id, version: manifest.version, manifestJson: manifest, status: "ready" });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "held-job", schedule: "* * * * *",
      nextRunAt: new Date(Date.now() - 60_000) });
    return { pluginId, jobId };
  }

  for (const trigger of ["schedule", "manual"] as const) {
    it(`awaits a ${trigger} dispatch and its final database writes after stop`, async () => {
      const { jobId } = await seed(), started = latch(), release = latch();
      const workerManager = createPluginWorkerManager();
      vi.spyOn(workerManager, "isRunning").mockReturnValue(true);
      vi.spyOn(workerManager, "call").mockImplementation(async () => { started.release(); await release.promise; });
      const scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager });
      const dispatch = trigger === "schedule" ? scheduler.tick() : scheduler.triggerJob(jobId);
      await started.promise;
      scheduler.stop();
      let settled = false;
      const drain = scheduler.drain().then(() => { settled = true; });
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(await db.select({ status: pluginJobRuns.status }).from(pluginJobRuns)).toEqual([{ status: "running" }]);
      } finally {
        release.release();
        await Promise.all([dispatch, drain]);
      }
      expect(await db.select({ status: pluginJobRuns.status }).from(pluginJobRuns)).toEqual([{ status: "succeeded" }]);
      if (trigger === "schedule") {
        const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
        expect(job!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      }
    });
  }

  it("awaits a lifecycle handler already running when event subscriptions stop", async () => {
    const { pluginId } = await seed(), started = latch(), release = latch();
    const jobStore = pluginJobStore(db), workerManager = createPluginWorkerManager();
    const scheduler = createPluginJobScheduler({ db, jobStore, workerManager });
    const lifecycle = pluginLifecycleManager(db, { workerManager });
    const coordinator = createPluginJobCoordinator({ db, jobStore, lifecycle, scheduler: { ...scheduler,
      unregisterPlugin: async id => { started.release(); await release.promise; await scheduler.unregisterPlugin(id); },
    } });
    coordinator.start();
    await lifecycle.disable(pluginId);
    await started.promise;
    coordinator.stop();
    let settled = false;
    const drain = coordinator.drain().then(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      release.release();
      await drain;
      await scheduler.drain();
    }
    expect(settled).toBe(true);
  });
});
