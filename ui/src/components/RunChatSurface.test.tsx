// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { RunChatSurface } from "./RunChatSurface";

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: () => <div data-testid="nux-thread">NUX thread</div>,
}));

const run: LiveRunForIssue = {
  id: "run-1",
  status: "running",
  agentId: "agent-1",
  agentName: "Agent",
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
} as LiveRunForIssue;

function act(callback: () => void) {
  flushSync(callback);
}

async function renderSurface(overrides: Partial<LiveRunForIssue> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RunChatSurface run={{ ...run, ...overrides }} transcript={[]} hasOutput={false} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunChatSurface thread presentation", () => {
  it("renders the graduated issue thread without a chat-flag branch", async () => {
    const { container, cleanup } = await renderSurface();
    expect(container.querySelector('[data-testid="nux-thread"]')).not.toBeNull();
    await cleanup();
  });

  it("announces ownership waiting without presenting agent output, then removes the wait after handoff", async () => {
    const waiting = await renderSurface({ filesystemOwnershipState: "waiting" });
    expect(waiting.container.querySelector('[role="status"]')?.textContent)
      .toContain("Waiting for exclusive filesystem ownership");
    expect(waiting.container.textContent).toContain("No agent work has started");
    await waiting.cleanup();
    for (const overrides of [
      { filesystemOwnershipState: "acquired" },
      { filesystemOwnershipState: "waiting", status: "cancelled" },
      {},
    ] as Partial<LiveRunForIssue>[]) {
      const surface = await renderSurface(overrides);
      expect(surface.container.querySelector('[role="status"]')).toBeNull();
      expect(surface.container.querySelector('[data-testid="nux-thread"]')).not.toBeNull();
      await surface.cleanup();
    }
  });
});
