// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyArtifact, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { AgentArtifactsPanel, AgentTasksPanel, sortAgentTasks } from "./AgentWorkPanels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  issuesList: vi.fn(),
  artifactsList: vi.fn(),
  liveRunsForCompany: vi.fn(),
  realFilters: false,
}));

vi.mock("@/api/issues", () => ({ issuesApi: { list: api.issuesList } }));
vi.mock("@/api/artifacts", () => ({ artifactsApi: { list: api.artifactsList } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: api.liveRunsForCompany } }));
vi.mock("@/components/IssueFiltersPopover", async () => {
  const actual = await vi.importActual<typeof import("@/components/IssueFiltersPopover")>("@/components/IssueFiltersPopover");
  return {
    ...actual,
    IssueFiltersPopover: (props: ComponentProps<typeof actual.IssueFiltersPopover>) => api.realFilters
      ? <actual.IssueFiltersPopover {...props} />
      : <button type="button">Filters</button>,
  };
});
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className, target, rel }: { to: string; children: ReactNode; className?: string; target?: string; rel?: string }) =>
    <a href={to} className={className} target={target} rel={rel}>{children}</a>,
}));

function task(overrides: Partial<Issue>): Issue {
  return {
    id: "task",
    identifier: "PAP-1",
    title: "Task",
    status: "todo",
    priority: "medium",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as Issue;
}

function liveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-1",
    issueId: "running",
    status: "running",
    invocationSource: "manual",
    triggerDetail: null,
    startedAt: "2026-10-05T00:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-10-05T00:00:00.000Z",
    agentId: "agent-1",
    agentName: "CEO",
    adapterType: "codex_local",
    ...overrides,
  };
}

function artifact(overrides: Partial<CompanyArtifact>): CompanyArtifact {
  return {
    id: "artifact",
    source: "document",
    mediaKind: "document",
    title: "report.md",
    issue: { id: "issue-1", identifier: "PAP-9", title: "Issue" },
    createdByAgent: { id: "agent-1", name: "CEO" },
    updatedAt: "2026-09-30T00:00:00.000Z",
    href: "/PAP/issues/PAP-9#document-report",
    ...overrides,
  } as CompanyArtifact;
}

describe("agent work panels", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    api.issuesList.mockReset();
    api.artifactsList.mockReset();
    api.liveRunsForCompany.mockReset();
    api.liveRunsForCompany.mockResolvedValue([]);
    api.realFilters = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("lists the agent's tasks newest first as linked cards, without the chat itself", async () => {
    api.issuesList.mockResolvedValue([
      task({ id: "old", identifier: "PAP-1", title: "Older task", updatedAt: new Date("2026-09-01T00:00:00.000Z") }),
      task({ id: "chat", identifier: "PAP-2", title: "The conversation" }),
      task({ id: "new", identifier: "PAP-3", title: "Newer task", status: "in_progress", updatedAt: new Date("2026-09-20T00:00:00.000Z") }),
    ]);
    await render(<AgentTasksPanel companyId="company-1" agentId="agent-1" excludeIssueId="chat" />);

    expect(api.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({ participantAgentId: "agent-1" }));
    const cards = Array.from(container.querySelectorAll("a"));
    expect(cards.map((card) => card.getAttribute("href"))).toEqual(["/issues/PAP-3", "/issues/PAP-1"]);
    expect(cards.every((card) => card.getAttribute("target") === "_blank")).toBe(true);
    expect(cards[0]?.textContent).toContain("Newer task");
    expect(cards[0]?.textContent).toContain("PAP-3");
    expect(container.querySelector("time")).not.toBeNull();
    expect(container.textContent).not.toContain("The conversation");
  });

  it("uses the real Live runs only filter with company-scoped live runs and updates without remounting", async () => {
    api.realFilters = true;
    // Radix measures the real checkbox and popover in jsdom; layout observation
    // is the only browser primitive stubbed, not either interaction component.
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    api.issuesList.mockResolvedValue([
      task({ id: "running", identifier: "PAP-1", title: "Running task", companyId: "company-1", status: "in_progress" }),
      task({ id: "idle", identifier: "PAP-2", title: "Idle task", companyId: "company-1", status: "in_progress" }),
      task({ id: "done", identifier: "PAP-3", title: "Completed task", companyId: "company-1", status: "done" }),
    ]);
    api.liveRunsForCompany.mockResolvedValue([
      liveRun(),
      liveRun({ id: "stale-terminal-run", issueId: "done" }),
    ]);
    const otherCompanyKey = queryKeys.liveRuns("company-2");
    queryClient.setQueryData(otherCompanyKey, [liveRun({ id: "foreign-run", issueId: "idle" })]);
    const otherCompanyRuns = queryClient.getQueryData(otherCompanyKey);
    await render(<AgentTasksPanel companyId="company-1" agentId="agent-1" />);
    const taskLinks = () => Array.from(container.querySelectorAll("a")).map((card) => card.getAttribute("href"));
    expect(taskLinks()).toEqual(["/issues/PAP-1", "/issues/PAP-2", "/issues/PAP-3"]);

    const trigger = container.querySelector<HTMLButtonElement>('button[title="Filter"]');
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });
    const liveOnlyLabel = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.trim() === "Live runs only");
    const checkbox = liveOnlyLabel?.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox).toBeInstanceOf(HTMLButtonElement);
    expect(checkbox!.getAttribute("aria-checked")).toBe("false");
    await act(async () => { checkbox!.click(); });
    expect(checkbox!.getAttribute("aria-checked")).toBe("true");
    expect(taskLinks()).toEqual(["/issues/PAP-1"]);
    expect(container.textContent).toContain("Running task");
    expect(container.textContent).not.toContain("Idle task");
    expect(container.textContent).not.toContain("Completed task");
    expect(api.liveRunsForCompany).toHaveBeenCalledWith("company-1");

    // The filter observes the normal company cache. Finishing a run removes the
    // task; a newly queued run appears without resetting the selected checkbox.
    await act(async () => { queryClient.setQueryData(queryKeys.liveRuns("company-1"), []); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(taskLinks()).toEqual([]);
    expect(container.textContent).toContain("No tasks match these filters.");
    await act(async () => {
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), [liveRun({ id: "queued-run", issueId: "idle", status: "queued", startedAt: null })]);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(taskLinks()).toEqual(["/issues/PAP-2"]);
    expect(checkbox!.getAttribute("aria-checked")).toBe("true");
    expect(queryClient.getQueryData(otherCompanyKey)).toEqual(otherCompanyRuns);
  });

  it("sorts by status and title on request", () => {
    const tasks = [
      task({ id: "a", title: "Bravo", status: "done" }),
      task({ id: "b", title: "Alpha", status: "in_progress" }),
    ];
    expect(sortAgentTasks(tasks, "status", "asc").map((item) => item.id)).toEqual(["b", "a"]);
    expect(sortAgentTasks(tasks, "title", "asc").map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("asks the server for the agent's artifacts and shows filename, date and task id", async () => {
    api.artifactsList.mockResolvedValue({
      artifacts: [artifact({ id: "mine", title: "plan.md" })],
      nextCursor: null,
    });
    await render(<AgentArtifactsPanel companyId="company-1" agentId="agent-1" />);

    expect(api.artifactsList).toHaveBeenCalledWith("company-1", expect.objectContaining({ agentId: "agent-1" }));
    const cards = Array.from(container.querySelectorAll("a"));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("href")).toBe("/PAP/issues/PAP-9#document-report");
    expect(cards[0]?.getAttribute("target")).toBe("_blank");
    expect(cards[0]?.textContent).toContain("plan.md");
    expect(cards[0]?.textContent).toContain("PAP-9");
    expect(cards[0]?.textContent).toContain("Updated");
  });
});
