import { describe, expect, it } from "vitest";
import {
  atlasGeminiRunArgs,
  createGeminiJsonlParser,
  detectGeminiAuthRequired,
  formatAgyStreamJsonInput,
  isGeminiTransientNetworkError,
  isGeminiSessionUnrecoverableError,
  parseAgyModelsOutput,
  parseGeminiJsonl,
  splitAgyModelEffort,
} from "./parse.js";

describe("parseGeminiJsonl", () => {
  it("collects assistant text from message events with string content", () => {
    const stdout = [
      '{"type":"init","session_id":"session-1"}',
      '{"type":"message","role":"user","content":"Respond with hello."}',
      '{"type":"message","role":"assistant","content":"hello","delta":true}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.summary).toBe("hello");
    expect(parsed.errorMessage).toBeNull();
  });

  it("collects assistant text from message events with structured object content", () => {
    const stdout = [
      '{"type":"init","session_id":"session-2"}',
      '{"type":"message","role":"assistant","content":{"content":[{"type":"text","text":"first part"},{"type":"text","text":"second part"}]}}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);

    expect(parsed.sessionId).toBe("session-2");
    expect(parsed.summary).toBe("first part\n\nsecond part");
    expect(parsed.errorMessage).toBeNull();
  });

  it("ignores non-assistant message events", () => {
    const stdout = [
      '{"type":"message","role":"user","content":"hidden user input"}',
      '{"type":"message","role":"system","content":"hidden system note"}',
      '{"type":"message","role":"assistant","content":"visible response"}',
      '{"type":"result","status":"success"}',
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);

    expect(parsed.summary).toBe("visible response");
  });

  it("captures assistant text from gemini CLI v0.38 stream-json schema", () => {
    const stdout = [
      JSON.stringify({
        type: "init",
        timestamp: "2026-05-04T05:43:41.203Z",
        session_id: "session-abc",
        model: "auto-gemini-3",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-04T05:43:41.205Z",
        role: "user",
        content: "Respond with hello.",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-05-04T05:43:45.198Z",
        role: "assistant",
        content: "hello.",
        delta: true,
      }),
      JSON.stringify({
        type: "result",
        timestamp: "2026-05-04T05:43:45.819Z",
        status: "success",
        stats: {
          total_tokens: 9468,
          input_tokens: 9095,
          output_tokens: 29,
          cached: 8132,
          duration_ms: 4616,
        },
      }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("hello.");
    expect(result.sessionId).toBe("session-abc");
    expect(result.errorMessage).toBeNull();
    expect(result.usage.inputTokens).toBe(963);
    expect(result.usage.outputTokens).toBe(373);
    expect(result.usage.cachedInputTokens).toBe(8132);
  });

  it("ignores user messages and only collects assistant content", () => {
    const stdout = [
      JSON.stringify({ type: "message", role: "user", content: "ignore me" }),
      JSON.stringify({ type: "message", role: "assistant", content: "first" }),
      JSON.stringify({ type: "message", role: "assistant", content: "second" }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("first\n\nsecond");
  });

  it("preserves the legacy claude-style `assistant` event handler", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "legacy-session",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "output_text", text: "legacy hello" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "legacy hello" }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.summary).toBe("legacy hello");
    expect(result.sessionId).toBe("legacy-session");
  });

  it("flags result events with status=error", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        status: "error",
        error: "boom",
      }),
    ].join("\n");

    const result = parseGeminiJsonl(stdout);
    expect(result.errorMessage).toBe("boom");
  });

  it("classifies non-interactive manual authorization failures as auth required", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "",
      stderr:
        "Error authenticating: FatalAuthenticationError: Manual authorization is required but the current session is non-interactive.",
    });

    expect(result.requiresAuth).toBe(true);
  });
});

describe("isGeminiSessionUnrecoverableError", () => {
  it("matches 'unknown session'", () => {
    expect(isGeminiSessionUnrecoverableError("", "Error: unknown session 'abc-123'")).toBe(true);
  });

  it("matches 'session ... not found'", () => {
    expect(isGeminiSessionUnrecoverableError("", "Resumed session abc-123 not found on disk")).toBe(true);
  });

  it("matches 'exceeds the maximum number of tokens' (compression overflow)", () => {
    const stderr =
      '_ApiError: {"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed 1048576","status":"INVALID_ARGUMENT"}} at ChatCompressionService.compress';
    expect(isGeminiSessionUnrecoverableError("", stderr)).toBe(true);
  });

  it("matches 'input token count exceeds'", () => {
    expect(
      isGeminiSessionUnrecoverableError("", "input token count exceeds maximum"),
    ).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(isGeminiSessionUnrecoverableError("", "Some other error")).toBe(false);
  });

  it("does not match transient network errors (those go to isGeminiTransientNetworkError)", () => {
    expect(
      isGeminiSessionUnrecoverableError(
        "",
        "_GaxiosError: getaddrinfo ENOTFOUND oauth2.googleapis.com",
      ),
    ).toBe(false);
  });
});

describe("isGeminiTransientNetworkError", () => {
  it("matches DNS failure on oauth2.googleapis.com", () => {
    const stderr =
      "_GaxiosError: request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com";
    expect(isGeminiTransientNetworkError("", stderr)).toBe(true);
  });

  it("matches EAI_AGAIN", () => {
    expect(
      isGeminiTransientNetworkError("", "Error: getaddrinfo EAI_AGAIN sts.googleapis.com"),
    ).toBe(true);
  });

  it("matches _UserRefreshClient ENOTFOUND", () => {
    const stderr =
      "at _UserRefreshClient.refreshTokenNoCache (.../google-auth-library/...)\n" +
      "  caused by: ENOTFOUND oauth2.googleapis.com";
    expect(isGeminiTransientNetworkError("", stderr)).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(isGeminiTransientNetworkError("", "Some other error")).toBe(false);
  });

  it("does not match unknown-session errors (those go to isGeminiSessionUnrecoverableError)", () => {
    expect(
      isGeminiTransientNetworkError("", "Error: unknown session 'abc-123'"),
    ).toBe(false);
  });
});


describe("Gemini accounting semantics", () => {
  it.each([
    [0, "result"], [1.25, "result"], [0, "step_finish"], [1.25, "step_finish"], [0, "usage"], [1.25, "usage"],
  ] as const)("invalidates an earlier $%s price when a later %s adds unpriced usage", (cost, type) => {
    const consume = createGeminiJsonlParser();
    const priced = JSON.stringify({ type: "step_finish", usage: { input_tokens: 10, output_tokens: 2 }, cost });
    const unpriced = JSON.stringify({ type, usage: { input_tokens: 20, output_tokens: 3 } });
    expect(consume(priced).costUsd).toBe(cost);
    const parsed = consume(unpriced);
    expect(parsed.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 5 });
    expect(parsed.costUsd).toBeNull();
    expect(parseGeminiJsonl(`${priced}\n${unpriced}`)).toEqual(parsed);
  });
  it.each([0, 2.5])("accepts a final reported total of $%s after earlier unpriced usage", (cost) => {
    const consume = createGeminiJsonlParser();
    expect(consume(JSON.stringify({ type: "step_finish", usage: { input_tokens: 10 } })).costUsd).toBeNull();
    expect(consume(JSON.stringify({ type: "result", total_cost_usd: cost })).costUsd).toBe(cost);
  });
  it("retains a reported price when later events add no usage", () => {
    const consume = createGeminiJsonlParser();
    consume(JSON.stringify({ type: "step_finish", usage: { input_tokens: 10 }, cost: 1.25 }));
    expect(consume(JSON.stringify({ type: "message", role: "assistant", content: "Done" })).costUsd).toBe(1.25);
    expect(consume(JSON.stringify({ type: "result", status: "success" })).costUsd).toBe(1.25);
  });
  it("keeps cache reads disjoint and includes thinking tokens in API metadata", () => {
    const parsed = parseGeminiJsonl(JSON.stringify({ type: "result", usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 } }));
    expect(parsed.usage).toEqual({ inputTokens: 20, cachedInputTokens: 80, outputTokens: 15 });
  });
  it("preserves explicit zero and distinguishes absent prices", () => {
    expect(parseGeminiJsonl(JSON.stringify({ type: "result", total_cost_usd: 0 })).costUsd).toBe(0);
    expect(parseGeminiJsonl(JSON.stringify({ type: "result" })).costUsd).toBeNull();
  });
});

describe("agy CLI helpers and stream-json parsing", () => {
  it("splits advertised agy effort suffixes into model and --effort", () => {
    expect(splitAgyModelEffort("gemini-4-neon-high")).toEqual({ model: "gemini-4-neon", effort: "high" });
    expect(splitAgyModelEffort("gemini-4-neon-xhigh")).toEqual({ model: "gemini-4-neon", effort: "xhigh" });
    expect(splitAgyModelEffort("gemini-4-neon-medium")).toEqual({ model: "gemini-4-neon", effort: "medium" });
    expect(splitAgyModelEffort("gemini-3.8-flash")).toEqual({ model: "gemini-3.8-flash", effort: null });
    expect(splitAgyModelEffort("gemini-high")).toEqual({ model: "gemini-high", effort: null });
  });

  it("validates Atlas agy run arguments strictly and derives permission bypass solely from controller policy", () => {
    expect(atlasGeminiRunArgs({ cliFlavor: "agy", model: "gemini-4-neon-high", dangerouslySkipPermissions: true })).toEqual([
      "--output-format", "stream-json", "--input-format", "stream-json",
      "--model", "gemini-4-neon", "--effort", "high",
    ]);
    expect(atlasGeminiRunArgs(
      { cliFlavor: "agy", model: "gemini-4-neon-high" },
      { dangerouslySkipPermissions: true },
    )).toEqual([
      "--output-format", "stream-json", "--input-format", "stream-json",
      "--model", "gemini-4-neon", "--effort", "high", "--dangerously-skip-permissions",
    ]);
    expect(atlasGeminiRunArgs({ cliFlavor: "agy", model: "gemini-3.8-flash" })).toEqual([
      "--output-format", "stream-json", "--input-format", "stream-json",
      "--model", "gemini-3.8-flash",
    ]);
    for (const invalid of [
      { cliFlavor: "gemini", model: "gemini-4-neon-high" },
      { cliFlavor: undefined, model: "gemini-4-neon-high" },
      { cliFlavor: "agy", model: "auto" },
      { cliFlavor: "agy", model: "claude-opus-5-5-max" },
      { cliFlavor: "agy", model: "-gemini-4-neon-high" },
      { cliFlavor: "agy", model: "google/gemini-4-neon-high" },
      { cliFlavor: "agy", model: `gemini-${"a".repeat(130)}` },
    ]) {
      expect(atlasGeminiRunArgs(invalid)).toBeNull();
    }
  });

  it("formats agy stream-json user turn input and parses agy models output", () => {
    expect(formatAgyStreamJsonInput("Respond with hello.")).toBe(
      `${JSON.stringify({ event: "user", message: { role: "user", content: "Respond with hello." } })}\n`,
    );
    expect(parseAgyModelsOutput([
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-3.8-flash\tGemini 3.8 Flash",
      "gemini-4-neon-high\tDuplicate",
      "gemini-2.5-pro",
      "",
    ].join("\n"))).toEqual([
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    ]);
  });

  it("parses agy stream-json init, step_update, and result without double-counting usage", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "conv-123", init: { model: "gemini-4-neon-high" } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-123", step_index: 0, state: "DONE", step_type: "user_input" } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-123", step_index: 1, state: "RUNNING", step_type: "agent_response", text_delta: "hello " } }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-123",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "world\n",
          usage: { input_tokens: 20, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 80, total_tokens: 35 },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-123",
          status: "SUCCESS",
          response: "hello world\n",
          num_turns: 1,
          usage: { input_tokens: 20, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 80, total_tokens: 35 },
        },
      }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-123");
    expect(parsed.summary).toBe("hello world");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.terminalStatus).toBe("success");
    expect(parsed.resultEvent).toMatchObject({ status: "SUCCESS", conversation_id: "conv-123" });
    expect(parsed.usage).toEqual({ inputTokens: 20, cachedInputTokens: 80, outputTokens: 15 });
  });

  it("retains completed step usage and null terminalStatus if agy exits before emitting a result event", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "conv-partial" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-partial",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "partial reply",
          usage: { input_tokens: 12, output_tokens: 7, thinking_tokens: 2, cache_read_tokens: 40, total_tokens: 19 },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-partial",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          usage: { input_tokens: 12, output_tokens: 7, thinking_tokens: 2, cache_read_tokens: 40, total_tokens: 19 },
        },
      }),
    ].join("\n");
    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("conv-partial");
    expect(parsed.summary).toBe("partial reply");
    expect(parsed.terminalStatus).toBeNull();
    expect(parsed.resultEvent).toBeNull();
    expect(parsed.usage).toEqual({ inputTokens: 12, cachedInputTokens: 40, outputTokens: 7 });
  });

  it("captures agy ERROR results (including empty diagnostics) and auth failures", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: "Eligibility check failed: PERMISSION_DENIED (code 403): forbidden. Please log out (/logout) and log back in (/login).",
        finished_reason: "error",
      },
    });
    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.terminalStatus).toBe("error");
    expect(parsed.errorMessage).toContain("PERMISSION_DENIED");
    expect(detectGeminiAuthRequired({ parsed: parsed.resultEvent, stdout, stderr: "" }).requiresAuth).toBe(true);
    expect(detectGeminiAuthRequired({ parsed: null, stdout: "", stderr: "Error: Please sign in to view available models." }).requiresAuth).toBe(true);

    const silentError = parseGeminiJsonl(JSON.stringify({
      event: "result",
      result: { conversation_id: "conv-silent", status: "ERROR", response: "", error: "" },
    }));
    expect(silentError.terminalStatus).toBe("error");
    expect(silentError.errorMessage).toContain("error");

    const errorAfterStep = parseGeminiJsonl([
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-err-usage",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          usage: { input_tokens: 18, output_tokens: 9, thinking_tokens: 3, cache_read_tokens: 50, total_tokens: 27 },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-err-usage",
          status: "SUCCESS",
          finished_reason: "error",
          usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        },
      }),
    ].join("\n"));
    expect(errorAfterStep.terminalStatus).toBe("error");
    expect(errorAfterStep.usage).toEqual({ inputTokens: 18, cachedInputTokens: 50, outputTokens: 9 });
  });
});
