import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";

const sweep = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/browser-use.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/browser-use.js")>();
  return { ...actual, browserUseService: (...args: Parameters<typeof actual.browserUseService>) => ({
    ...actual.browserUseService(...args), sweep,
  }) };
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("application background shutdown settlement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-app-drain-"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-app-drain-db-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  it("awaits startup reconciliation and export writes before reporting shutdown complete", async () => {
    const browserGate = latch(), exportGate = latch(), browserStarted = latch(), exportStarted = latch();
    const browserCompleted = latch(), exportCompleted = latch();
    sweep.mockImplementation(async () => {
      browserStarted.release();
      await browserGate.promise;
      const id = randomUUID();
      await db.insert(companies).values({ id, name: "Settled browser sweep", issuePrefix: id.slice(0, 8) });
      browserCompleted.release();
    });
    const { createApp } = await import("../app.js");
    const app = await createApp(db, { uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "authenticated", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false, instanceId: `drain-${randomUUID()}`, managedPluginAutoInstall: [],
      localPluginDir: join(root, "plugins"), decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      feedbackExportService: { flushPendingFeedbackTraces: async () => {
        exportStarted.release();
        await exportGate.promise;
        const id = randomUUID();
        await db.insert(companies).values({ id, name: "Settled export", issuePrefix: id.slice(0, 8) });
        exportCompleted.release();
      } },
    });
    await Promise.all([browserStarted.promise, exportStarted.promise]);
    let settled = false;
    const shutdown = app.locals.paperclipShutdown().then(() => { settled = true; });
    try {
      const completedEarly = await Promise.race([shutdown.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))]);
      expect(completedEarly).toBe(false);
      browserGate.release();
      await browserCompleted.promise;
      expect(settled).toBe(false);
    } finally {
      browserGate.release();
      exportGate.release();
      await Promise.all([browserCompleted.promise, exportCompleted.promise]);
      await shutdown;
      await app.locals.bundledPluginsStartup;
      sweep.mockReset();
    }
    expect((await db.select({ name: companies.name }).from(companies)).map(row => row.name).sort())
      .toEqual(["Settled browser sweep", "Settled export"]);
  }, 30_000);
});
