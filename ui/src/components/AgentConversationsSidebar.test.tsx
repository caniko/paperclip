// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { AgentConversationsSidebar } from "./AgentConversationsSidebar";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-a" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewAgent: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/A/chats/alpha" }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => null }));

it("puts an older active conversation above newer chats without changing the saved order", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const roster = ["zed", "beta", "carol", "alpha"].map((id) => ({
    id, companyId: "company-a", name: id, urlKey: id, role: "general", title: "Teammate", status: "idle",
  } as Agent));
  const savedChats = [
    { id: "chat-beta", conversationAgentId: "beta", updatedAt: "2026-09-02T00:00:00Z" },
    { id: "chat-alpha", conversationAgentId: "alpha", updatedAt: "2026-09-01T00:00:00Z" },
  ];
  const chatKey = queryKeys.agentChats.list("company-a", "user-a");
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  client.setQueryData(queryKeys.agents.list("company-a"), roster);
  client.setQueryData(queryKeys.resourceMemberships.mine("company-a"), {
    projectMemberships: {}, agentMemberships: {}, starredProjectIds: [], starredAgentIds: [], starredDocumentIds: [],
  });
  client.setQueryData(chatKey, savedChats);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}><AgentConversationsSidebar /></QueryClientProvider>,
    ));
    const links = container.querySelectorAll('nav[aria-label="Agent conversations"] a');
    expect([...links].map((link) => link.getAttribute("href")))
      .toEqual(["/chats/alpha", "/chats/beta", "/chats/carol", "/chats/zed"]);
    expect(client.getQueryData(chatKey)).toEqual(savedChats);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});
