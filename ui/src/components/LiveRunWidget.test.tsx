// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { LiveRunWidget } from "./LiveRunWidget";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/AgentIdentity", () => ({
  AgentIdentity: () => <span>Filesystem worker</span>,
}));
vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), hasOutputForRun: () => false }),
}));
vi.mock("./RunChatSurface", async () => {
  const { FilesystemOwnershipNotice } = await import("./FilesystemOwnershipNotice");
  return { RunChatSurface: ({ run }: { run: LiveRunForIssue }) => <FilesystemOwnershipNotice run={run} /> };
});

const active: LiveRunForIssue = {
  id: "ownership-wait", status: "running", invocationSource: "manual", triggerDetail: null,
  startedAt: null, finishedAt: null, createdAt: "2026-09-30T12:00:00.000Z",
  agentId: "agent-1", agentName: "Filesystem worker", adapterType: "hermes_gateway",
  filesystemOwnershipState: "waiting",
};

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

async function renderWidget(liveRuns: LiveRunForIssue[] = []) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.issues.activeRun("issue-1"), active);
  client.setQueryData(queryKeys.issues.liveRuns("issue-1"), liveRuns);
  vi.spyOn(heartbeatsApi, "activeRunForIssue").mockResolvedValue(active);
  vi.spyOn(heartbeatsApi, "liveRunsForIssue").mockResolvedValue(liveRuns);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}><LiveRunWidget issueId="issue-1" /></QueryClientProvider>);
  });
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LiveRunWidget ownership waiting", () => {
  it.each([false, true])("preserves the active-run wait through deduplication (also live: %s)", async (alsoLive) => {
    await renderWidget(alsoLive ? [{ ...active, startedAt: null, finishedAt: null, createdAt: String(active.createdAt) }] : []);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("No agent work has started");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    await act(async () => {
      client.setQueryData(queryKeys.issues.activeRun("issue-1"), { ...active, filesystemOwnershipState: "acquired" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps the wait visible until cancellation is acknowledged and refreshes both run projections", async () => {
    await renderWidget();
    let finish!: () => void;
    const cancel = vi.spyOn(heartbeatsApi, "cancel").mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve();
    }));
    const stop = container.querySelector("button")!;
    await act(async () => stop.click());
    expect(cancel).toHaveBeenCalledExactlyOnceWith(active.id);
    expect(stop.textContent).toContain("Stopping");
    expect(stop.disabled).toBe(true);
    expect(container.textContent).toContain("No agent work has started");
    vi.mocked(heartbeatsApi.activeRunForIssue).mockResolvedValue(null);
    vi.mocked(heartbeatsApi.liveRunsForIssue).mockResolvedValue([]);
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.textContent).toBe(""));
  });

  it("announces a failed cancellation while preserving ownership waiting and the Stop action", async () => {
    await renderWidget();
    vi.spyOn(heartbeatsApi, "cancel").mockRejectedValue(new Error("Authority is unavailable"));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Authority is unavailable");
    expect(container.textContent).toContain("No agent work has started");
    expect(container.querySelector("button")?.disabled).toBe(false);
  });
});
