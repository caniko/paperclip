import { afterEach, describe, expect, it, vi } from "vitest";
import { selectExecutor } from "./executor-selection.js";
import { executionAffinityScope, sessionCodec } from "./index.js";

const primary = "https://workers.example/atlas";
const secondary = "https://workers.example/nomad";
const config = { apiBaseUrl: primary, executorEndpoints: [primary, secondary], apiKey: "fixture-key" };
const ready = (accepting = true, availableSlots = 1) => new Response(JSON.stringify({
  features: {
    runs_executor_admission: { version: 1, accepting, available_slots: availableSlots },
    runs_recovery: { version: 1, durable_lineage_stop: true, admission_binding: 1, ordinary_stop_admission: true },
  },
}));
afterEach(() => vi.unstubAllGlobals());

describe("Hermes executor selection before admission", () => {
  it("uses the actual issue conversation key and treats an unscoped timer as fresh", () => {
    expect(executionAffinityScope(config, { taskKey: "__heartbeat__", wakeSource: "timer" })).toBeNull();
    expect(executionAffinityScope(config, { taskKey: "cache-alias", issueId: "issue-one" })).toEqual({
      scope: "issue", taskKey: "issue-one", primaryEndpoint: primary,
    });
    expect(executionAffinityScope({ ...config, sessionKeyStrategy: " AGENT " }, { issueId: "issue-two" })).toEqual({
      scope: "agent", taskKey: null, primaryEndpoint: primary,
    });
    expect(executionAffinityScope({ ...config, apiBaseUrl: "https://user:private@example.test", sessionKeyStrategy: "agent" }, {})).toBeNull();
  });

  it("an explicit reset tombstone overrides a stale issue-local worker result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith(primary) ? ready(false) : ready()));
    expect(await selectExecutor({ config, executionAffinity: { endpoint: null }, runtime: {
      sessionParams: { executorBaseUrl: primary, sessionKey: "stale-before-reset" },
    } })).toBe(secondary);
  });

  it("selects fresh for an unscoped issue-strategy timer despite a cached provider result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith(primary) ? ready(false) : ready()));
    expect(await selectExecutor({ config, context: { wakeSource: "timer" }, runtime: {
      sessionId: "previous-issue", sessionParams: { executorBaseUrl: primary },
    } })).toBe(secondary);
  });
  it("uses the primary when ready and sends authentication without redirects", async () => {
    const fetch = vi.fn(async () => ready());
    vi.stubGlobal("fetch", fetch);
    expect(await selectExecutor({ config, runtime: {} })).toBe(primary);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${primary}/v1/capabilities`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fixture-key" }), redirect: "error",
    }));
  });

  it.each(["busy", "detached", "unreachable", "old_worker"])("falls back before admission when the primary is %s", async (state) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith(secondary)) return ready();
      if (state === "unreachable") throw new Error("offline");
      if (state === "old_worker") return new Response(JSON.stringify({ features: {} }));
      return ready(state !== "detached", state === "busy" ? 0 : 1);
    }));
    expect(await selectExecutor({ config, runtime: {} })).toBe(secondary);
  });

  it("refuses a detached secondary without making a run request", async () => {
    const fetch = vi.fn(async (url: string) => ready(url.startsWith(primary), 0));
    vi.stubGlobal("fetch", fetch);
    await expect(selectExecutor({ config, runtime: {} })).rejects.toMatchObject({ code: "hermes_gateway_executor_unavailable" });
    expect(fetch.mock.calls.every(([url]) => url.endsWith("/v1/capabilities"))).toBe(true);
  });

  it("retains session affinity rather than moving a conversation to a ready primary", async () => {
    const fetch = vi.fn(async (_url: string) => ready(false));
    vi.stubGlobal("fetch", fetch);
    await expect(selectExecutor({ config, runtime: { sessionParams: { executorBaseUrl: secondary } } }))
      .rejects.toMatchObject({ code: "hermes_gateway_executor_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${secondary}/v1/capabilities`);
  });

  it("pins pre-pool sessions and protected targets to the primary", async () => {
    const fetch = vi.fn(async (_url: string) => ready(false));
    vi.stubGlobal("fetch", fetch);
    for (const input of [{ runtime: { sessionId: "old-session" } }, { runtime: {}, config: { ...config, bindWorkspace: true } }]) {
      await expect(selectExecutor({ config, ...input })).rejects.toMatchObject({ code: "hermes_gateway_executor_unavailable" });
    }
    expect(fetch.mock.calls.every(([url]) => url === `${primary}/v1/capabilities`)).toBe(true);
  });

  it("allows secondary selection for an ordinary unbound local execution target", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ready(true, url.startsWith(primary) ? 0 : 1)));
    expect(await selectExecutor({ config, runtime: {}, executionTarget: { kind: "local" } })).toBe(secondary);
  });

  it("rejects a stale affinity URL rather than sending credentials to it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(selectExecutor({ config, runtime: { sessionParams: { executorBaseUrl: "https://removed.example" } } }))
      .rejects.toMatchObject({ code: "hermes_gateway_executor_affinity_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an explicit reset when a pool is removed from a secondary session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(selectExecutor({ config: { apiBaseUrl: primary }, runtime: { sessionParams: { executorBaseUrl: secondary } } }))
      .rejects.toMatchObject({ code: "hermes_gateway_executor_affinity_invalid" });
  });

  it.each(["run", "none"])("selects fresh for the non-continuous %s session strategy", async (sessionKeyStrategy) => {
    vi.stubGlobal("fetch", vi.fn(async () => ready()));
    expect(await selectExecutor({ config: { ...config, sessionKeyStrategy },
      runtime: { sessionParams: { executorBaseUrl: secondary } } })).toBe(primary);
  });

  it.each([
    [primary, "http://remote.example"], [secondary, primary], [primary, "https://user:secret@remote.example"],
    [primary, "https://remote.example?token=secret"], [primary, "https://remote.example#fragment"], [],
  ].map((endpoints) => ({ endpoints })))("validates the entire configured inventory before probing: $endpoints", async ({ endpoints }) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(selectExecutor({ config: { ...config, executorEndpoints: endpoints }, runtime: {} })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not conceal a primary authentication refusal with fallback", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(selectExecutor({ config, runtime: {} })).rejects.toMatchObject({ code: "hermes_gateway_executor_auth_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the exact endpoint through the persisted session codec", () => {
    const session = { hermesSessionId: "session", executorBaseUrl: secondary };
    expect(sessionCodec.deserialize(sessionCodec.serialize(session))).toEqual(session);
  });
});
