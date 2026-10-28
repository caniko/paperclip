// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { DEFAULT_INVALIDATION_INTERVAL_MS } from "../lib/query-invalidation-batcher";

const { pushToast, companySelection, routeSelection } = vi.hoisted(() => ({ pushToast: vi.fn(), companySelection: { id: "company-1" }, routeSelection: { pathname: "/tasks" } }));
const { sessionRead, healthRead } = vi.hoisted(() => ({ sessionRead: vi.fn(), healthRead: vi.fn() }));
vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: companySelection.id, selectedCompany: { id: companySelection.id } }),
}));
vi.mock("./ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("../lib/router", () => ({ useLocation: () => routeSelection }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: sessionRead },
}));
vi.mock("../api/health", () => ({ healthApi: { get: healthRead } }));
import { LiveUpdatesProvider, useHasCompanyLiveConnection, useTaskRunLiveUpdates } from "./LiveUpdatesProvider";
import { liveRunRefetchInterval } from "../lib/live-runs-cache";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Socket {
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ type: string; revision?: number }> = [];
  constructor() { Socket.instances.push(this); }
  send(encoded: string) { this.sent.push(JSON.parse(encoded)); }
  close() { this.readyState = 3; }
}

describe("LiveUpdatesProvider connection recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const read = vi.fn(async () => "current task data");
  const pollRead = vi.fn<() => Promise<unknown>>();

  beforeEach(() => {
    vi.useFakeTimers();
    companySelection.id = "company-1";
    routeSelection.pathname = "/tasks";
    pollRead.mockReset().mockResolvedValue([]);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    read.mockReset();
    read.mockResolvedValue("current task data");
    sessionRead.mockReset().mockResolvedValue({ user: { id: "viewer" }, session: { id: "session", userId: "viewer" } });
    healthRead.mockReset().mockResolvedValue({ deploymentMode: "authenticated" });
    Socket.instances = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" }, session: { id: "session", userId: "viewer" } });
    client.setQueryData(queryKeys.health, { deploymentMode: "authenticated" });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render() {
    function Tasks() {
      const { data } = useQuery({ queryKey: ["company-1", "tasks"], queryFn: read });
      return <span>{data}</span>;
    }
    await act(async () => root.render(
      <QueryClientProvider client={client}><LiveUpdatesProvider><Tasks /></LiveUpdatesProvider></QueryClientProvider>,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }

  function IdleRuns({ companyId }: { companyId: string }) {
    const connected = useHasCompanyLiveConnection(companyId);
    useQuery({
      queryKey: [companyId, "idle-run-fixture"],
      queryFn: pollRead,
      refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, 1000),
    });
    return <span>{connected ? "connected" : "fallback"}</span>;
  }

  async function renderPolling(companyId = companySelection.id, withProvider = true) {
    const child = <IdleRuns companyId={companyId} />;
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        {withProvider ? <LiveUpdatesProvider>{child}</LiveUpdatesProvider> : child}
      </QueryClientProvider>,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }

  async function advancePolls(count: number) {
    for (let i = 0; i < count; i += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(1001));
    }
  }

  it.each([false, true])("discovers a run started in the resync gap after acknowledgement (older read pending=%s)", async pending => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling();
    const socket = Socket.instances[0];
    const deliver = async (type: string, extras: Record<string, unknown> = {}) => {
      await act(async () => socket.onmessage?.({ data: JSON.stringify({ type, version: 1, ...extras }) }));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    };
    await act(async () => socket.onopen?.());
    await deliver("live.capabilities", { capabilities: ["run-interests"] });
    await deliver("live.subscribed", { revision: socket.sent.at(-1)!.revision });
    pollRead.mockClear();
    let release!: (value: unknown) => void;
    if (pending) pollRead.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await deliver("live.resync", { revision: socket.sent.at(-1)!.revision });
    expect(pollRead).toHaveBeenCalledOnce();
    const next = [{ id: "new-run", status: "running" }];
    pollRead.mockResolvedValue(next);
    await deliver("live.subscribed", { revision: socket.sent.at(-1)!.revision });
    if (pending) {
      expect(pollRead).toHaveBeenCalledOnce();
      await act(async () => release([]));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    expect(pollRead).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(["company-1", "idle-run-fixture"])).toEqual(next);
  });

  it.each(["unmount", "disconnect", "company", "session", "hidden"])("discards a queued resync-ack refresh after %s", async change => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling();
    const socket = Socket.instances[0];
    const deliver = async (type: string, extras: Record<string, unknown> = {}) => {
      await act(async () => socket.onmessage?.({ data: JSON.stringify({ type, version: 1, ...extras }) }));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    };
    await act(async () => socket.onopen?.());
    await deliver("live.capabilities", { capabilities: ["run-interests"] });
    await deliver("live.subscribed", { revision: socket.sent.at(-1)!.revision });
    let release!: (value: unknown) => void;
    pollRead.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await deliver("live.resync", { revision: socket.sent.at(-1)!.revision });
    await deliver("live.subscribed", { revision: socket.sent.at(-1)!.revision });
    if (change === "unmount") await act(async () => root.unmount());
    if (change === "disconnect") await act(async () => socket.onerror?.());
    if (change === "company") { companySelection.id = "company-2"; await renderPolling(); }
    if (change === "session") {
      const next = { user: { id: "viewer" }, session: { id: "replacement", userId: "viewer" } };
      sessionRead.mockResolvedValue(next);
      await act(async () => client.setQueryData(queryKeys.auth.session, next));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    if (change === "hidden") await act(async () => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const reads = pollRead.mock.calls.length;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => release([]));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(pollRead).toHaveBeenCalledTimes(reads);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([null, []])("keeps setup polling, then stops known-empty polling after connection for %j", async (data) => {
    vi.stubGlobal("WebSocket", Socket);
    pollRead.mockResolvedValue(data);
    await renderPolling();
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    await advancePolls(3);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(3);
    await act(async () => Socket.instances[0].onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toBe("connected");
    const readsAfterOpen = pollRead.mock.calls.length;
    await advancePolls(10);
    expect(pollRead).toHaveBeenCalledTimes(readsAfterOpen);
  });

  it.each([[{ id: "run-1" }], { id: "run-1" }])("keeps active work polling while connected for %j", async (data) => {
    vi.stubGlobal("WebSocket", Socket);
    pollRead.mockResolvedValue(data);
    await renderPolling();
    await act(async () => Socket.instances[0].onopen?.());
    pollRead.mockClear();
    await advancePolls(3);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps polling a failed query with previously empty data until it recovers", async () => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling();
    await act(async () => Socket.instances[0].onopen?.());
    pollRead.mockRejectedValue(new Error("Read unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["company-1", "idle-run-fixture"] }); });
    expect(client.getQueryState(["company-1", "idle-run-fixture"])?.status).toBe("error");
    pollRead.mockClear();
    await advancePolls(3);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(3);
    pollRead.mockResolvedValue([]);
    await advancePolls(1);
    expect(client.getQueryState(["company-1", "idle-run-fixture"])?.status).toBe("success");
    const afterRecovery = pollRead.mock.calls.length;
    await advancePolls(5);
    expect(pollRead).toHaveBeenCalledTimes(afterRecovery);
  });

  it("retains an initial pending read until it resolves after the connection opens", async () => {
    vi.stubGlobal("WebSocket", Socket);
    let resolveRead!: (value: unknown) => void;
    pollRead.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    await renderPolling();
    await act(async () => Socket.instances[0].onopen?.());
    expect(container.textContent).toBe("connected");
    expect(client.getQueryState(["company-1", "idle-run-fixture"])?.status).toBe("pending");
    expect(pollRead).toHaveBeenCalledTimes(1);
    await act(async () => resolveRead([]));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(client.getQueryData(["company-1", "idle-run-fixture"])).toEqual([]);
    await advancePolls(5);
    expect(pollRead).toHaveBeenCalledTimes(1);
  });

  it("resumes local polling on error before close, and stops it after recovery", async () => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling();
    const first = Socket.instances[0];
    await act(async () => first.onopen?.());
    await act(async () => first.onerror?.());
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    await advancePolls(3);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(3);
    await act(async () => first.onclose?.());
    await advancePolls(2);
    expect(Socket.instances.length).toBeGreaterThan(1);
    await act(async () => Socket.instances.at(-1)?.onopen?.());
    expect(container.textContent).toBe("connected");
    const afterRecovery = pollRead.mock.calls.length;
    await advancePolls(10);
    expect(pollRead).toHaveBeenCalledTimes(afterRecovery);
  });

  it.each(["company", "session"])("requires a new connection after a %s change and ignores stale callbacks", async (scope) => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling();
    const first = Socket.instances[0];
    await act(async () => first.onopen?.());
    const oldOpen = first.onopen, oldClose = first.onclose, oldError = first.onerror;
    if (scope === "company") {
      companySelection.id = "company-2";
      await renderPolling();
    } else {
      const nextSession = { user: { id: "viewer" }, session: { id: "replacement-session", userId: "viewer" } };
      sessionRead.mockResolvedValue(nextSession);
      await act(async () => client.setQueryData(queryKeys.auth.session, nextSession));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    expect(container.textContent).toBe("fallback");
    await act(async () => oldOpen?.());
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    await advancePolls(2);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => Socket.instances.at(-1)?.onopen?.());
    expect(container.textContent).toBe("connected");
    await act(async () => { oldClose?.(); oldError?.(); });
    expect(container.textContent).toBe("connected");
    const afterOpen = pollRead.mock.calls.length;
    await advancePolls(5);
    expect(pollRead).toHaveBeenCalledTimes(afterOpen);
  });

  it("discovers matching new runs after empty polling stops on an unfocused non-task route", async () => {
    vi.stubGlobal("WebSocket", Socket);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const queryRef = "DEMO-1";
    const runRead = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const activeRead = vi.fn<() => Promise<unknown>>().mockResolvedValue(null);
    function TaskRuns() {
      const connected = useTaskRunLiveUpdates({ companyId: "company-1", issueId: "issue-1", issueQueryRef: queryRef, assigneeAgentId: "agent-1" });
      const runs = useQuery({ queryKey: queryKeys.issues.liveRuns(queryRef), queryFn: runRead,
        refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, 1000) });
      useQuery({ queryKey: queryKeys.issues.activeRun(queryRef), queryFn: activeRead,
        refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, 1000) });
      return <span>{JSON.stringify(runs.data)}</span>;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><LiveUpdatesProvider><TaskRuns /></LiveUpdatesProvider></QueryClientProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const socket = Socket.instances[0];
    await act(async () => socket.onopen?.());
    runRead.mockClear(); activeRead.mockClear();
    await advancePolls(5);
    expect(runRead).not.toHaveBeenCalled();
    expect(activeRead).not.toHaveBeenCalled();
    const deliver = async (companyId: string, payload: Record<string, unknown>) => {
      await act(async () => socket.onmessage?.({ data: JSON.stringify({ id: 1, companyId,
        type: "heartbeat.run.queued", createdAt: "2020-01-01T00:00:00Z", payload }) }));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    };
    await deliver("company-2", { issueId: "issue-1", agentId: "agent-1", runId: "foreign" });
    await deliver("company-1", { issueId: "other-issue", agentId: "agent-1", runId: "other" });
    expect(runRead).not.toHaveBeenCalled();
    expect(activeRead).not.toHaveBeenCalled();
    runRead.mockResolvedValue([{ id: "new-run", status: "running" }]);
    activeRead.mockResolvedValue({ id: "new-run", status: "running" });
    await deliver("company-1", { issueId: "issue-1", agentId: "new-agent", runId: "new-run" });
    expect(runRead).toHaveBeenCalledTimes(1);
    expect(activeRead).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("new-run");
    await deliver("company-1", { agentId: "reviewer-agent", runId: "reviewer-run-without-task-id" });
    expect(runRead).toHaveBeenCalledTimes(2);
    expect(activeRead).toHaveBeenCalledTimes(2);
  });

  it.each(["initial", "background", "connection setup"])("refetches after an older empty %s read settles when run events arrive during it", async (phase) => {
    vi.stubGlobal("WebSocket", Socket);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const queryKey = queryKeys.issues.liveRuns("DEMO-1");
    const runRead = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    let resolveOlder!: (value: unknown) => void;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    if (phase !== "background") runRead.mockImplementationOnce(() => older);
    function TaskRuns() {
      const connected = useTaskRunLiveUpdates({ companyId: "company-1", issueId: "issue-1", issueQueryRef: "DEMO-1", assigneeAgentId: "agent-1" });
      const { data } = useQuery({ queryKey, queryFn: runRead,
        refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, 1000) });
      return <span>{JSON.stringify(data)}</span>;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><LiveUpdatesProvider><TaskRuns /></LiveUpdatesProvider></QueryClientProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const socket = Socket.instances[0];
    await act(async () => socket.onopen?.());
    if (phase === "background") {
      runRead.mockClear();
      runRead.mockImplementationOnce(() => older);
      await act(async () => { void client.invalidateQueries({ queryKey }); });
    }
    runRead.mockResolvedValue([{ id: "new-run", status: "running" }]);
    expect(runRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (let id = 1; phase !== "connection setup" && id <= 3; id += 1) socket.onmessage?.({ data: JSON.stringify({ id,
        companyId: "company-1", type: "heartbeat.run.queued", createdAt: "2020-01-01T00:00:00Z",
        payload: { issueId: "issue-1", agentId: "agent-1", runId: "new-run" } }) });
    });
    expect(runRead).toHaveBeenCalledTimes(1);
    await act(async () => resolveOlder([]));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(runRead).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(queryKey)).toEqual([{ id: "new-run", status: "running" }]);
    expect(container.textContent).toContain("new-run");
  });

  it.each(["unmount", "disconnect", "company", "session", "task"])("discards the old follow-up refresh after %s during an older read", async (change) => {
    vi.stubGlobal("WebSocket", Socket);
    let resolveOlder!: (value: unknown) => void;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    const runRead = vi.fn<() => Promise<unknown>>().mockResolvedValue([]).mockImplementationOnce(() => older);
    function TaskRuns({ task = "1" }: { task?: string }) {
      const queryRef = `DEMO-${task}`;
      const connected = useTaskRunLiveUpdates({ companyId: "company-1", issueId: `issue-${task}`, issueQueryRef: queryRef, assigneeAgentId: "agent-1" });
      useQuery({ queryKey: queryKeys.issues.liveRuns(queryRef), queryFn: runRead,
        refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, 1000) });
      return null;
    }
    const render = async (task = "1") => {
      await act(async () => root.render(<QueryClientProvider client={client}><LiveUpdatesProvider><TaskRuns task={task} /></LiveUpdatesProvider></QueryClientProvider>));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    };
    await render();
    const socket = Socket.instances[0];
    await act(async () => socket.onopen?.());
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ id: 1, companyId: "company-1",
      type: "heartbeat.run.queued", createdAt: "2020-01-01T00:00:00Z",
      payload: { issueId: "issue-1", agentId: "agent-1", runId: "new-run" } }) }));
    if (change === "unmount") await act(async () => root.unmount());
    if (change === "disconnect") await act(async () => socket.onerror?.());
    if (change === "company") { companySelection.id = "company-2"; await render(); }
    if (change === "task") await render("2");
    if (change === "session") {
      const nextSession = { user: { id: "viewer" }, session: { id: "replacement-session", userId: "viewer" } };
      sessionRead.mockResolvedValue(nextSession);
      await act(async () => client.setQueryData(queryKeys.auth.session, nextSession));
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    const readsAfterChange = runRead.mock.calls.length;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolveOlder([]));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(runRead).toHaveBeenCalledTimes(readsAfterChange);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each(["focused", "unfocused"])("refreshes once for a start event with two run observers on a %s task view", async focus => {
    vi.stubGlobal("WebSocket", Socket);
    vi.spyOn(document, "hasFocus").mockReturnValue(focus === "focused");
    routeSelection.pathname = "/DEMO/issues/DEMO-1";
    const queryRef = "DEMO-1";
    client.setQueryData(queryKeys.issues.detail(queryRef), { id: "issue-1", companyId: "company-1", assigneeAgentId: "agent-1" });
    const runRead = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const activeRead = vi.fn<() => Promise<unknown>>().mockResolvedValue(null);
    function Reads({ connected, interval }: { connected: boolean; interval: number }) {
      useQuery({ queryKey: queryKeys.issues.liveRuns(queryRef), queryFn: runRead,
        refetchInterval: query => liveRunRefetchInterval(connected, query.state, interval) });
      useQuery({ queryKey: queryKeys.issues.activeRun(queryRef), queryFn: activeRead,
        refetchInterval: query => liveRunRefetchInterval(connected, query.state, interval) });
      return null;
    }
    function TaskRuns() {
      const connected = useTaskRunLiveUpdates({ companyId: "company-1", issueId: "issue-1", issueQueryRef: queryRef, assigneeAgentId: "agent-1" });
      return <><Reads connected={connected} interval={1000} /><Reads connected={connected} interval={3000} /></>;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><LiveUpdatesProvider><TaskRuns /></LiveUpdatesProvider></QueryClientProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const socket = Socket.instances[0];
    await act(async () => socket.onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(301));
    runRead.mockClear(); activeRead.mockClear();
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ id: 1, companyId: "company-1",
      type: "heartbeat.run.queued", createdAt: "2020-01-01T00:00:00Z",
      payload: { agentId: "agent-1", runId: "new-run" } }) }));
    await act(async () => vi.advanceTimersByTimeAsync(301));
    expect(runRead).toHaveBeenCalledTimes(1);
    expect(activeRead).toHaveBeenCalledTimes(1);
  });

  it("keeps polling unassigned tasks even with a healthy shared connection", async () => {
    vi.stubGlobal("WebSocket", Socket);
    function UnassignedTask() {
      const connected = useTaskRunLiveUpdates({ companyId: "company-1", issueId: "issue-1", issueQueryRef: "issue-1", assigneeAgentId: null });
      useQuery({ queryKey: queryKeys.issues.liveRuns("issue-1"), queryFn: pollRead,
        refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, 1000) });
      return <span>{connected ? "connected" : "fallback"}</span>;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><LiveUpdatesProvider><UnassignedTask /></LiveUpdatesProvider></QueryClientProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await act(async () => Socket.instances[0].onopen?.());
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    await advancePolls(2);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("retains polling for another company and outside the provider", async () => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling("company-2");
    await act(async () => Socket.instances[0].onopen?.());
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    await advancePolls(2);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(2);
    await renderPolling("company-2", false);
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    await advancePolls(2);
    expect(pollRead.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("drops readiness while hidden and does not poll or retry after unmount", async () => {
    vi.stubGlobal("WebSocket", Socket);
    await renderPolling();
    await act(async () => Socket.instances[0].onopen?.());
    const visibility = vi.spyOn(document, "visibilityState", "get");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toBe("fallback");
    pollRead.mockClear();
    const count = Socket.instances.length;
    await advancePolls(5);
    expect(pollRead).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(count);
    await act(async () => root.unmount());
    await advancePolls(5);
    expect(pollRead).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(count);
  });

  it("reconciles updates between the initial query and the first socket connection", async () => {
    vi.stubGlobal("WebSocket", Socket);
    await render();
    expect(container.textContent).toBe("current task data");
    expect(Socket.instances).toHaveLength(1);

    // The server saves a reply after the page read but before it subscribes.
    // There is no event replay and this is not a reconnect.
    read.mockResolvedValue("reply saved during connection setup");
    await act(async () => Socket.instances[0].onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toBe("reply saved during connection setup");
    expect(sessionRead).not.toHaveBeenCalled();
    expect(healthRead).not.toHaveBeenCalled();
    const readsAfterConnect = read.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(readsAfterConnect);
    await act(async () => Socket.instances[0].onclose?.());
    await act(async () => vi.advanceTimersByTimeAsync(1_001));
    await act(async () => Socket.instances.at(-1)?.onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(sessionRead).toHaveBeenCalled();
    expect(healthRead).toHaveBeenCalled();
  });

  it.each([
    "issue.attachment_added",
    "issue.attachment_removed",
    "issue.work_product_created",
    "issue.work_product_updated",
    "issue.work_product_deleted",
    "issue.document_created",
    "issue.document_updated",
    "issue.document_restored",
    "issue.document_deleted",
  ])("refreshes mounted agent artifact queries for connected %s activity only in that company", async (action) => {
    vi.stubGlobal("WebSocket", Socket);
    const readAgentArtifacts = vi.fn(async () => ["old-output.md"]);
    const readCatalog = vi.fn(async () => ["old-output.md"]);
    const readOtherCompany = vi.fn(async () => ["other-company.md"]);
    const mounted = vi.fn();
    const otherCompanyKey = queryKeys.artifacts.byAgent("company-2", "agent-2");

    function Artifacts() {
      useEffect(() => { mounted(); }, []);
      const agent = useQuery({
        queryKey: queryKeys.artifacts.byAgent("company-1", "agent-1"),
        queryFn: readAgentArtifacts,
      });
      const catalog = useQuery({
        queryKey: queryKeys.artifacts.list("company-1", "document"),
        queryFn: readCatalog,
      });
      const other = useQuery({ queryKey: otherCompanyKey, queryFn: readOtherCompany });
      return <>
        <span data-testid="agent-artifacts">{agent.data?.join(", ")}</span>
        <span data-testid="artifact-catalog">{catalog.data?.join(", ")}</span>
        <span data-testid="other-company-artifacts">{other.data?.join(", ")}</span>
      </>;
    }

    await act(async () => root.render(
      <QueryClientProvider client={client}><LiveUpdatesProvider><Artifacts /></LiveUpdatesProvider></QueryClientProvider>,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0];
    expect(socket.onmessage).toBeTypeOf("function");
    await act(async () => socket.onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[data-testid="agent-artifacts"]')?.textContent).toBe("old-output.md");
    expect(container.querySelector('[data-testid="artifact-catalog"]')?.textContent).toBe("old-output.md");
    expect(container.querySelector('[data-testid="other-company-artifacts"]')?.textContent).toBe("other-company.md");
    const agentReadsAfterConnect = readAgentArtifacts.mock.calls.length;
    const catalogReadsAfterConnect = readCatalog.mock.calls.length;
    const otherReadsAfterConnect = readOtherCompany.mock.calls.length;
    const otherStateAfterConnect = client.getQueryState(otherCompanyKey);

    // Change the backing API results after socket-open reconciliation. A normal
    // activity event must refresh these observers without a reconnect or remount.
    readAgentArtifacts.mockResolvedValue(["old-output.md", "new-output.md"]);
    readCatalog.mockResolvedValue(["old-output.md", "new-output.md"]);
    await act(async () => socket.onmessage!(new MessageEvent("message", {
      data: JSON.stringify({
        id: 1,
        companyId: "company-1",
        type: "activity.logged",
        createdAt: "2026-10-05T00:00:00.000Z",
        payload: {
          entityType: "issue",
          entityId: "issue-1",
          action,
          actorType: "agent",
          actorId: "agent-1",
          details: { key: "report" },
        },
      }),
    })));
    expect(readAgentArtifacts).toHaveBeenCalledTimes(agentReadsAfterConnect);
    await act(async () => vi.advanceTimersByTimeAsync(DEFAULT_INVALIDATION_INTERVAL_MS + 1));

    expect(readAgentArtifacts).toHaveBeenCalledTimes(agentReadsAfterConnect + 1);
    expect(readCatalog).toHaveBeenCalledTimes(catalogReadsAfterConnect + 1);
    expect(container.querySelector('[data-testid="agent-artifacts"]')?.textContent).toBe("old-output.md, new-output.md");
    expect(container.querySelector('[data-testid="artifact-catalog"]')?.textContent).toBe("old-output.md, new-output.md");
    expect(readOtherCompany).toHaveBeenCalledTimes(otherReadsAfterConnect);
    expect(client.getQueryState(otherCompanyKey)).toEqual(otherStateAfterConnect);
    expect(container.querySelector('[data-testid="other-company-artifacts"]')?.textContent).toBe("other-company.md");
    expect(Socket.instances).toHaveLength(1);
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "throws"])("polls visible data and resumes realtime when the constructor %s", async (failure) => {
    vi.stubGlobal("WebSocket", failure === "missing" ? undefined : class {
      constructor() { throw new DOMException("Blocked", "SecurityError"); }
    });
    await render();
    expect(container.textContent).toBe("current task data");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(read).toHaveBeenCalledTimes(2);

    vi.stubGlobal("WebSocket", Socket);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(Socket.instances).toHaveLength(1);
    await act(async () => Socket.instances[0].onopen?.());
    const readsAfterRecovery = read.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(readsAfterRecovery);
    expect(Socket.instances).toHaveLength(1);

    // An ordinary disconnect must re-enable the same fallback.
    await act(async () => Socket.instances[0].onclose?.());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(read.mock.calls.length).toBeGreaterThan(readsAfterRecovery);
  });

  it("stops fallback reads and connection retries while hidden and after unmount", async () => {
    const construct = vi.fn();
    vi.stubGlobal("WebSocket", class {
      constructor() { construct(); throw new Error("Unavailable"); }
    });
    await render();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const attempts = construct.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledTimes(attempts);
    await act(async () => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(15_001));
    expect(read.mock.calls.length).toBeGreaterThan(1);
    await act(async () => root.unmount());
    const readsAtUnmount = read.mock.calls.length;
    const attemptsAtUnmount = construct.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(readsAtUnmount);
    expect(construct).toHaveBeenCalledTimes(attemptsAtUnmount);
  });
});
