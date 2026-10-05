// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Link, useLocation } from "@/lib/router";
import { TASK_LAST_VIEW_KEY } from "@/lib/task-views";
import { Issues } from "./Issues";

const fixture = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
  openNewIssue: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: fixture.setBreadcrumbs }),
}));
vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }),
}));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }),
}));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({
  useCombinedInboxTasksEnabled: () => ({ enabled: true, loaded: true }),
}));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0 }) }));
vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }),
  usePublishSharedQueryData: () => {},
}));
vi.mock("@/api/issues", () => ({ issuesApi: { listCompact: async () => [], update: vi.fn() } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/components/IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Isolate collection contents; route resolution, storage, the company-aware
// router, and the Views menu remain their real implementations.
vi.mock("./Inbox", () => ({
  Inbox: ({ tab, toolbarContext }: { tab: string; toolbarContext: ReactNode }) => (
    <section>
      {toolbarContext}
      <div data-testid="inbox-view">{tab}</div>
    </section>
  ),
}));
vi.mock("@/components/IssuesList", () => ({
  IssuesList: ({ initialStatuses, toolbarContext }: { initialStatuses?: string[]; toolbarContext: ReactNode }) => (
    <section>
      {toolbarContext}
      <div data-testid="task-statuses">{JSON.stringify(initialStatuses)}</div>
    </section>
  ),
}));

function TasksRoute() {
  const location = useLocation();
  useEffect(() => {
    fixture.mounted();
    return () => { fixture.unmounted(); };
  }, []);
  return (
    <>
      <Link to="/issues" aria-label="Open bare Tasks route">Tasks</Link>
      <output data-testid="route-location">{`${location.pathname}${location.search}`}</output>
      <Issues />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.localStorage.clear();
  fixture.setBreadcrumbs.mockClear();
  fixture.openNewIssue.mockClear();
  fixture.mounted.mockClear();
  fixture.unmounted.mockClear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it("remembers Done when a bare Tasks link is followed in the same mounted route", async () => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/PAP/issues"]}>
          <Routes>
            <Route path="/:companyPrefix/issues" element={<TasksRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  expect(container.querySelector('[data-testid="inbox-view"]')?.textContent).toBe("mine");
  expect(container.querySelector('[data-testid="route-location"]')?.textContent).toBe("/PAP/issues?view=mine");
  expect(fixture.mounted).toHaveBeenCalledTimes(1);

  const menu = container.querySelector<HTMLButtonElement>('button[aria-label="Change view — currently Mine"]')!;
  expect(menu).not.toBeNull();
  await act(async () => {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  const done = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((item) => item.textContent?.startsWith("Done"));
  expect(done).toBeDefined();
  await act(async () => done!.click());

  expect(window.localStorage.getItem(TASK_LAST_VIEW_KEY)).toBe("done");
  expect(container.querySelector('button[aria-label="Change view — currently Done"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="task-statuses"]')?.textContent).toBe('["done","cancelled"]');
  expect(container.querySelector('[data-testid="route-location"]')?.textContent).toBe("/PAP/issues?view=done");

  const tasksLink = container.querySelector<HTMLAnchorElement>('a[aria-label="Open bare Tasks route"]')!;
  expect(tasksLink.getAttribute("href")).toBe("/PAP/issues");
  await act(async () => tasksLink.click());

  expect(container.querySelector('[data-testid="route-location"]')?.textContent).toBe("/PAP/issues?view=done");
  expect(container.querySelector('button[aria-label="Change view — currently Done"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="task-statuses"]')?.textContent).toBe('["done","cancelled"]');
  expect(container.querySelector('[data-testid="inbox-view"]')).toBeNull();
  expect(fixture.mounted).toHaveBeenCalledTimes(1);
  expect(fixture.unmounted).not.toHaveBeenCalled();
});
