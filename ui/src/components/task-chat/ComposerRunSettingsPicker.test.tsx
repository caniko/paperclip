// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "@/api/agents";
import { ComposerRunSettingsPicker } from "./ComposerRunSettingsPicker";

const agent = {
  id: "a1", companyId: "company-1", name: "Clippy",
  role: "Engineering Lead",
  adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" },
} as unknown as Agent;
const options = [{ id: "agent:a1", label: "Clippy" }];
const agents = new Map([[agent.id, agent]]);
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

async function flushTimers() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((item) => item.textContent?.trim().startsWith(label));
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await flushTimers();
}

function render(onAssigneeChange: (value: string) => void, onSettingsChange: () => void, useCatalog = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(<QueryClientProvider client={queryClient!}>
    <ComposerRunSettingsPicker companyId="company-1" assigneeValue="agent:a1" currentAssigneeValue="agent:a1"
      options={options} agents={agents} settings={{ model: "gpt-6-sol", effort: "high", fast: true }}
      onAssigneeChange={onAssigneeChange} onSettingsChange={onSettingsChange}
      modelOptionsOverride={useCatalog ? undefined : []} />
  </QueryClientProvider>));
}

afterEach(async () => {
  try {
    await act(async () => root?.unmount());
    queryClient?.clear();
    // Radix defers focus restoration. Settle it while the JSDOM event realm
    // and React globals still exist, before the test environment is disposed.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    root = null;
    queryClient = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe("composer assignee picker", () => {
  it("lets the assignee and model use the available composer width", () => {
    render(vi.fn(), vi.fn());
    const trigger = container!.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-assignee"]');
    const assignee = trigger!.querySelector('[data-testid="task-chat-composer-assignee-label"]');
    const model = trigger!.querySelector('[data-testid="task-chat-composer-model-label"]');

    expect(trigger?.className).toContain("max-w-full");
    expect(trigger?.className).not.toContain("max-w-64");
    expect(assignee?.className).toContain("min-w-0");
    expect(assignee?.className).not.toContain("max-w-24");
    expect(model?.className).toContain("min-w-0");
    expect(assignee?.className).toContain("truncate");
    expect(model?.className).toContain("truncate");
  });

  it("finds assignees by their displayed role and harness", async () => {
    render(vi.fn(), vi.fn());
    await click("Select assignee, model and effort");
    await click("Choose assignee");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search assignees"]');
    expect(input).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const query of ["Engineering Lead", "Codex"]) {
      act(() => {
        setValue.call(input, query);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect([...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
        .some((option) => option.textContent?.includes("Clippy"))).toBe(true);
    }
  });

  it("offers the Codex CLI catalog instead of unrelated OpenAI API models", async () => {
    vi.spyOn(agentsApi, "adapterModels").mockResolvedValueOnce([
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
    render(vi.fn(), vi.fn(), true);
    await flushTimers();
    await click("Select assignee, model and effort");
    await click("Choose exact model");
    const options = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .map((item) => item.textContent ?? "");
    expect(options.some((item) => item.includes("gpt-5.5"))).toBe(true);
    expect(options.some((item) => item.includes("gpt-6-sol"))).toBe(true);
    expect(options.some((item) => item.includes("gpt-image"))).toBe(false);
    expect(options.some((item) => item.includes("text-embedding"))).toBe(false);
    expect(document.body.textContent).not.toContain("Loading models…");
  });

  it("shows an instance-declared Codex model list instead of bundled alternatives", async () => {
    const loadModels = vi.spyOn(agentsApi, "adapterModels").mockResolvedValueOnce([
      { id: "private-codex", label: "Private Codex" },
    ]);
    render(vi.fn(), vi.fn(), true);
    await flushTimers();
    expect(loadModels).toHaveBeenCalledWith("company-1", "codex_local", {
      environmentId: null,
      provider: undefined,
    });
    await click("Select assignee, model and effort");
    await click("Choose exact model");
    const choices = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .map((item) => item.textContent ?? "");
    expect(choices.some((item) => item.includes("Private Codex"))).toBe(true);
    expect(choices.some((item) => item.includes("GPT-6 Sol"))).toBe(false);
  });

  it("preserves settings when the selected assignee is chosen again", async () => {
    const onAssigneeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(onAssigneeChange, onSettingsChange);
    await click("Select assignee, model and effort");
    await click("Choose assignee");
    await click("Clippy");
    expect(onAssigneeChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("offers No assignee and clears settings when selected", async () => {
    const onAssigneeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(onAssigneeChange, onSettingsChange);
    await click("Select assignee, model and effort");
    await click("Choose assignee");
    await click("No assignee");
    expect(onAssigneeChange).toHaveBeenCalledWith("");
    expect(onSettingsChange).toHaveBeenCalledWith({ model: null, effort: null, fast: false });
  });
});
