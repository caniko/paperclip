import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

const ATLAS_GEMINI_MODEL_PATTERN = /^gemini-[A-Za-z0-9._-]+$/;
const ATLAS_GEMINI_MODEL_MAX_LEN = 128;
const AGY_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const AGY_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_AGY_COUNTED_STEPS = 10_000;

/** Split an advertised agy model ID with an effort suffix (e.g. gemini-4-neon-high)
 * into the base inference model and explicit --effort flag. */
export function splitAgyModelEffort(model: string): { model: string; effort: string | null } {
  const dash = model.lastIndexOf("-");
  if (dash <= 0 || dash === model.length - 1) return { model, effort: null };
  const base = model.slice(0, dash);
  const effort = model.slice(dash + 1);
  if (!AGY_EFFORTS.has(effort)) return { model, effort: null };
  if (model.startsWith("gemini-") && !ATLAS_GEMINI_MODEL_PATTERN.test(base)) {
    return { model, effort: null };
  }
  return { model: base, effort };
}

/** Only server-admitted pins are used by the Atlas agy run and hello probe.
 * Permission bypass is controlled solely by controller policy and defaults off. */
export function atlasGeminiRunArgs(
  config: Record<string, unknown>,
  policy?: Readonly<{ dangerouslySkipPermissions?: boolean }>,
): string[] | null {
  const { cliFlavor, model } = config;
  if (cliFlavor !== "agy" || typeof model !== "string") return null;
  if (model.length > ATLAS_GEMINI_MODEL_MAX_LEN || !ATLAS_GEMINI_MODEL_PATTERN.test(model)) return null;
  const resolved = splitAgyModelEffort(model);
  const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--model", resolved.model];
  if (resolved.effort) args.push("--effort", resolved.effort);
  if (policy?.dangerouslySkipPermissions === true) args.push("--dangerously-skip-permissions");
  return args;
}

export function formatAgyStreamJsonInput(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
}

export function parseAgyModelsOutput(stdout: string): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const models: Array<{ id: string; label: string }> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tabIndex = line.indexOf("\t");
    const id = (tabIndex === -1 ? line : line.slice(0, tabIndex)).trim();
    const label = (tabIndex === -1 ? id : line.slice(tabIndex + 1).trim()) || id;
    if (!AGY_MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(message);
  const direct = asString(record.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text, "").trim() || asString(part.content, "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  const result = parseObject(event.result);
  const stepUpdate = parseObject(event.step_update);
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    asString(event.conversation_id, "").trim() ||
    asString(result.conversation_id, "").trim() ||
    asString(stepUpdate.conversation_id, "").trim() ||
    asString(event.checkpoint_id, "").trim() ||
    asString(event.thread_id, "").trim() ||
    null
  );
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
) {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage.usageMetadata);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;

  // Gemini CLI's input_tokens is the full prompt; input is uncached input.
  // https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/stream-json-formatter.ts
  const cached = asNumber(source.cached_input_tokens,
    asNumber(source.cachedInputTokens, asNumber(source.cachedContentTokenCount, asNumber(source.cached, 0))));
  const prompt = asNumber(source.input_tokens, asNumber(source.inputTokens, asNumber(source.promptTokenCount, 0)));
  const toolInput = asNumber(source.toolUsePromptTokenCount, 0);
  target.inputTokens += Math.max(0, asNumber(source.input, prompt - cached)) + toolInput;
  target.cachedInputTokens += cached;
  // The streaming CLI omits a separate thought count, but includes it in total_tokens.
  const response = asNumber(source.output_tokens, asNumber(source.outputTokens, asNumber(source.candidatesTokenCount, 0)));
  const total = asNumber(source.total_tokens, asNumber(source.totalTokenCount, 0));
  target.outputTokens += Math.max(response + asNumber(source.thoughtsTokenCount, 0), total - prompt - toolInput);

}

function readAgyUsage(usageRaw: unknown): { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null {
  const source = parseObject(usageRaw);
  if (Object.keys(source).length === 0) return null;
  const inputTokens = Math.max(0, asNumber(source.input_tokens, 0));
  const cachedInputTokens = Math.max(0, asNumber(source.cache_read_tokens, 0));
  const output = Math.max(0, asNumber(source.output_tokens, 0));
  const thinking = Math.max(0, asNumber(source.thinking_tokens, 0));
  const total = Math.max(0, asNumber(source.total_tokens, 0));
  // agy reports input_tokens already excluding cache_read_tokens, output_tokens
  // already including thinking_tokens, and total_tokens = input_tokens + output_tokens.
  const outputTokens = Math.max(output, thinking, total - inputTokens);
  return { inputTokens, cachedInputTokens, outputTokens };
}

export function parseGeminiJsonl(stdout: string) {
  return createGeminiJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createGeminiJsonlParser() {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const agyStepTexts = new Map<string, string>();
  const agyCountedSteps = new Set<string>();
  const agyStepUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let agyFinalUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null = null;
  let agyFinalResponse: string | null = null;
  let terminalStatus: "success" | "error" | null = null;
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let question: { prompt: string; choices: Array<{ key: string; label: string; description?: string }> } | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const recordAccounting = (event: Record<string, unknown>, usageRaw: unknown) => {
    const before = { ...usage };
    accumulateUsage(usage, usageRaw);
    const reportedCost = [event.total_cost_usd, event.cost_usd, event.cost]
      .find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (typeof reportedCost === "number") costUsd = reportedCost;
    else if (usage.inputTokens !== before.inputTokens || usage.cachedInputTokens !== before.cachedInputTokens || usage.outputTokens !== before.outputTokens) {
      // An earlier price, including explicit zero, cannot cover new unpriced
      // usage. Text-only or terminal events with no new usage leave it intact.
      costUsd = null;
    }
  };

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const event = parseJson(line);
      if (!event) continue;

      const foundSessionId = readSessionId(event);
      if (foundSessionId) sessionId = foundSessionId;

      const type = asString(event.type, "").trim();
      const agyEvent = type ? "" : asString(event.event, "").trim();

      if (agyEvent === "init") {
        continue;
      }

      if (agyEvent === "step_update") {
        const step = parseObject(event.step_update);
        const stepKey = typeof step.step_index === "number" ? String(step.step_index) : "__anon";
        if (asString(step.step_type, "").trim() === "agent_response") {
          const delta = typeof step.text_delta === "string" ? step.text_delta : "";
          if (delta) {
            agyStepTexts.set(stepKey, `${agyStepTexts.get(stepKey) ?? ""}${delta}`);
          }
        }
        if (asString(step.state, "").trim().toUpperCase() === "DONE" && !agyCountedSteps.has(stepKey)) {
          const stepUsage = readAgyUsage(step.usage);
          if (stepUsage) {
            if (agyCountedSteps.size >= MAX_AGY_COUNTED_STEPS) {
              throw new Error(`agy accounting exceeded maximum distinct step count (${MAX_AGY_COUNTED_STEPS})`);
            }
            agyCountedSteps.add(stepKey);
            agyStepUsage.inputTokens += stepUsage.inputTokens;
            agyStepUsage.cachedInputTokens += stepUsage.cachedInputTokens;
            agyStepUsage.outputTokens += stepUsage.outputTokens;
          }
        }
        continue;
      }

      if (agyEvent === "result") {
        const agyResult = parseObject(event.result);
        resultEvent = agyResult;
        const responseText = asString(agyResult.response, "").trim();
        if (responseText) agyFinalResponse = responseText;
        const status = asString(agyResult.status, "").trim().toLowerCase();
        const finishedReason = asString(agyResult.finished_reason, "").trim().toLowerCase();
        if (status === "success" && finishedReason !== "error") {
          terminalStatus = "success";
        } else {
          terminalStatus = "error";
          const text = asErrorText(agyResult.error ?? agyResult.message ?? agyResult.response).trim();
          errorMessage = text || (status ? `agy run failed with status ${status}` : "agy run failed without an error message");
        }
        const finalUsage = readAgyUsage(agyResult.usage);
        if (finalUsage) {
          agyFinalUsage = terminalStatus === "success"
            ? finalUsage
            : {
                inputTokens: Math.max(finalUsage.inputTokens, agyStepUsage.inputTokens),
                cachedInputTokens: Math.max(finalUsage.cachedInputTokens, agyStepUsage.cachedInputTokens),
                outputTokens: Math.max(finalUsage.outputTokens, agyStepUsage.outputTokens),
              };
        }
        continue;
      }

      if (type === "assistant") {
        messages.push(...collectMessageText(event.message));
        const messageObj = parseObject(event.message);
        const content = Array.isArray(messageObj.content) ? messageObj.content : [];
        for (const partRaw of content) {
          const part = parseObject(partRaw);
          if (asString(part.type, "").trim() === "question") {
            question = {
              prompt: asString(part.prompt, "").trim(),
              choices: (Array.isArray(part.choices) ? part.choices : []).map((choiceRaw) => {
                const choice = parseObject(choiceRaw);
                return {
                  key: asString(choice.key, "").trim(),
                  label: asString(choice.label, "").trim(),
                  description: asString(choice.description, "").trim() || undefined,
                };
              }),
            };
            break; // only one question per message
          }
        }
        continue;
      }

      // Gemini CLI v0.38+ stream-json schema emits assistant turns as:
      // {"type":"message","role":"assistant","content":"...","delta":true}
      // These are discrete final messages (one per assistant turn), not
      // cumulative streaming tokens, so collecting all of them produces the
      // expected concatenated turn-by-turn summary rather than duplicated text.
      if (type === "message") {
        const role = asString(event.role, "").trim().toLowerCase();
        if (role === "assistant") {
          messages.push(...collectMessageText(event.content));
        }
        continue;
      }

      if (type === "result") {
        resultEvent = event;
        recordAccounting(event, event.usage ?? event.usageMetadata ?? event.stats);
        const resultText =
          asString(event.result, "").trim() ||
          asString(event.text, "").trim() ||
          asString(event.response, "").trim();
        if (resultText && messages.length === 0) messages.push(resultText);
        const status = asString(event.status, "").toLowerCase();
        const isError =
          event.is_error === true ||
          asString(event.subtype, "").toLowerCase() === "error" ||
          status === "error" ||
          status === "failed";
        if (isError) {
          const text = asErrorText(event.error ?? event.message ?? event.result).trim();
          if (text) errorMessage = text;
        }
        continue;
      }

      if (type === "error") {
        const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
        if (text) errorMessage = text;
        continue;
      }

      if (type === "system") {
        const subtype = asString(event.subtype, "").trim().toLowerCase();
        if (subtype === "error") {
          const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
          if (text) errorMessage = text;
        }
        continue;
      }

      if (type === "text") {
        const part = parseObject(event.part);
        const text = asString(part.text, "").trim();
        if (text) messages.push(text);
        continue;
      }

      if (type === "step_finish" || event.usage || event.usageMetadata) {
        recordAccounting(event, event.usage ?? event.usageMetadata);
        continue;
      }
    }

    const effectiveAgyUsage = agyFinalUsage ?? agyStepUsage;
    const summary =
      messages.length > 0
        ? messages.join("\n\n").trim()
        : agyStepTexts.size > 0
          ? [...agyStepTexts.values()].map((text) => text.trim()).filter(Boolean).join("\n\n").trim()
          : agyFinalResponse ?? "";

    return {
      sessionId,
      summary,
      usage: {
        inputTokens: usage.inputTokens + effectiveAgyUsage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens + effectiveAgyUsage.cachedInputTokens,
        outputTokens: usage.outputTokens + effectiveAgyUsage.outputTokens,
      },
      costUsd,
      errorMessage,
      terminalStatus,
      resultEvent,
      question,
    };
  };
}

export function isGeminiSessionUnrecoverableError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|checkpoint\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume|exceeds\s+the\s+maximum\s+number\s+of\s+tokens|input\s+token\s+count\s+exceeds/i.test(
    haystack,
  );
}

export function isGeminiTransientNetworkError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /ENOTFOUND\s+oauth2\.googleapis\.com|ENOTFOUND\s+sts\.googleapis\.com|EAI_AGAIN|_GaxiosError.*ENOTFOUND|_UserRefreshClient.*ENOTFOUND/i.test(
    haystack,
  );
}

function extractGeminiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const errorMsg = asString(parsed.error, "").trim();
  if (errorMsg) messages.push(errorMsg);

  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }
    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function describeGeminiFailure(parsed: Record<string, unknown>): string | null {
  const status = asString(parsed.status, "");
  const errors = extractGeminiErrorMessages(parsed);

  const detail = errors[0] ?? "";
  const parts = ["Gemini run failed"];
  if (status) parts.push(`status=${status}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

const GEMINI_AUTH_REQUIRED_RE = /(?:not\s+authenticated|please\s+authenticate|please\s+sign\s+in|log\s+out\s*\(\/logout\)\s+and\s+log\s+back\s+in|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|manual\s+authorization\s+is\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?gemini\s+auth(?:\s+login)?`?\s+first)/i;
const GEMINI_QUOTA_EXHAUSTED_RE =
  /(?:resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details)/i;

export function detectGeminiAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresAuth = messages.some((line) => GEMINI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

export function detectGeminiQuotaExhausted(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { exhausted: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const exhausted = messages.some((line) => GEMINI_QUOTA_EXHAUSTED_RE.test(line));
  return { exhausted };
}

export function isGeminiTurnLimitResult(
  parsed: Record<string, unknown> | null | undefined,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  if (!parsed) return false;

  const structuredStopReasons = [
    parsed.status,
    parsed.stopReason,
    parsed.stop_reason,
    parsed.errorCode,
    parsed.error_code,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "turn_limit" ||
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit_exhausted",
  );
}
