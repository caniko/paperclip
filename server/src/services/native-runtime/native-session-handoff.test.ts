import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, documents, heartbeatRunEvents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import type { PrpEvent } from "@paperclipai/paperclip-runner";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildNativeSessionHandoff, createNativeSessionHandoffLoader, NATIVE_HANDOFF_MAX_BYTES, renderNativeSessionHandoff } from "./native-session-handoff.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { projectNativeRuntimeRequest } from "./native-question-bridge.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

describe("bounded fresh-session handoff", () => {
  it("marks omissions and stays within its byte budget for huge Unicode histories", () => {
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: 1, omittedEntriesAtLeast: 1,
      entries: Array.from({ length: 100 }, (_, i) => ({ kind: "message", id: String(i), body: "🦖".repeat(10_000) })),
    });
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(rendered).toContain('"truncated":true');
    expect(rendered).toContain("content omitted");
    expect(rendered).toContain("get_task_history");
    expect(rendered).toContain("Legacy adapters can use the equivalent Paperclip");
  });

  it("restores the handoff on fresh bootstrap and resume failure, without replaying it on resume", () => {
    const input = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent", normalizedSessionId: "session", conversationMode: true,
      issue: { id: "task", identifier: "BOT-2", title: "Chat", description: null, workMode: "standard" },
      taskPrompt: "GitHub is connected", freshSessionHandoff: "original goal: build the PR review bot", initialCommunicationGuidance: "Lead with the answer",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Build bot", criteria: [{ id: "objective", requirement: "Build bot" }],
      } }, runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("original goal");
    const resumed = buildNativeModelEnvelope(input, { resumedSession: true });
    expect("task" in resumed && resumed.task.prompt).not.toContain("original goal");
    // The runtime uses the same full envelope if actual recovery fails.
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("Lead with the answer");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("handoff history scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), boundaryId = randomUUID(), requestId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "HAND" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dickens", role: "general", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "user", conversationState: "active", conversationSessionGeneration: 2 });
    await db.insert(issueComments).values([
      { companyId, issueId, body: "OLD TOPIC", authorUserId: "user", createdAt: new Date(1_000) },
      { id: boundaryId, companyId, issueId, body: "/new", authorUserId: "user", createdAt: new Date(2_000) },
      { id: requestId, companyId, issueId, body: "Build a GitHub PR review bot\n" + "x".repeat(6_000) + "\nFinal constraint: require a team review", authorUserId: "user", createdAt: new Date(3_000) },
      { companyId, issueId, body: "Deleted private message", authorUserId: "user", createdAt: new Date(4_000), deletedAt: new Date(5_000) },
      { companyId, issueId, body: "UNTRUSTED BODY", authorAgentId: agentId, createdAt: new Date(5_000),
        sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: issueId } },
      { companyId, issueId, body: "FUTURE MESSAGE", authorUserId: "user", createdAt: new Date(30_000) },
    ]);
    await db.update(issues).set({ conversationBoundaryCommentId: boundaryId }).where(eq(issues.id, issueId));
    const decisionRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: decisionRunId, companyId, agentId, status: "succeeded", nativeIssueId: issueId,
      contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(2_500), finishedAt: new Date(7_000) });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, sourceRunId: decisionRunId, createdAt: new Date(6_000), resolvedAt: new Date(7_000),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "Use CODEOWNERS and publish a Storybook per PR" },
    });
    // An activity can start before the wake while its answer arrives later.
    // The answer timestamp, not just the activity's start, fences replay.
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, sourceRunId: decisionRunId, createdAt: new Date(2_500), resolvedAt: new Date(3_500),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "LATER CUTOFF DECISION" },
    });
    const laterAnswerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterAnswerRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(2_500), finishedAt: new Date(3_600),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "LATER CUTOFF RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: laterAnswerRunId, seq: 1, eventType: "item.completed", createdAt: new Date(3_500),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "LATER CUTOFF REPLY" } } } });
    const runId = randomUUID(), documentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(8_000), finishedAt: new Date(9_500),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "Waiting for GitHub access before configuring PR checks" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(9_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "Repository research complete; next configure PR checks" } } } });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Saved plan: review changed files by CODEOWNERS", updatedAt: new Date(10_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan", createdAt: new Date(10_000) });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 2 },
        resultJson: { summary: "Legacy answer: repository selection is complete" }, createdAt: new Date(12_000), finishedAt: new Date(13_000) },
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: randomUUID(), conversationSessionGeneration: 2 },
        resultJson: { summary: "UNRELATED TASK ANSWER" }, createdAt: new Date(14_000), finishedAt: new Date(15_000) },
    ]);
  });
  afterAll(async () => database?.cleanup());
  it("preserves the original goal and prior answer while excluding reset, deleted and future history", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).toContain("Final constraint: require a team review");
    expect(result).toContain('"truncated":true');
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(result).toContain("CODEOWNERS");
    expect(result).toContain("Repository research complete");
    expect(result).toContain("Saved plan");
    expect(result).toContain("Waiting for GitHub access");
    expect(result).toContain("Legacy answer: repository selection is complete");
    expect(result).not.toContain("UNRELATED TASK ANSWER");
    expect(result).not.toContain("OLD TOPIC");
    expect(result).not.toContain("Deleted private message");
    expect(result).not.toContain("FUTURE MESSAGE");
    expect(result).not.toContain("UNTRUSTED BODY");
    expect(result).not.toContain("/new");
    expect(await buildNativeSessionHandoff({ db, companyId: randomUUID(), issueId, agentId, before: new Date(20_000) })).toBeNull();
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId: randomUUID(), before: new Date(20_000) })).toBeNull();
  });
  it("honors the exact wake-comment cutoff when building a fresh replay", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: requestId });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).not.toContain("CODEOWNERS");
    expect(result).not.toContain("Legacy answer");
    expect(result).not.toContain("LATER CUTOFF DECISION");
    expect(result).not.toContain("LATER CUTOFF REPLY");
    expect(result).not.toContain("LATER CUTOFF RUN SUMMARY");
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: randomUUID() })).toBeNull();
  });

  it("loads and redacts history once only when a fresh attempt requests it", async () => {
    const select = vi.spyOn(db, "select");
    try {
      const load = createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before: new Date(20_000) });
      expect(select).not.toHaveBeenCalled();
      const first = await load();
      const reads = select.mock.calls.length;
      expect(reads).toBeGreaterThan(0);
      expect(await load()).toBe(first);
      expect(select).toHaveBeenCalledTimes(reads);
    } finally { select.mockRestore(); }
  });

  it("retains a prior run's quarantine after the current agent and task use standard policy", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", nativeIssueId: issueId,
      contextSnapshot: { issueId, conversationSessionGeneration: 2, executionPolicy: {
        trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, issueIds: [issueId] } },
      } }, createdAt: new Date(16_000), finishedAt: new Date(18_000),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "QUARANTINED RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(17_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "QUARANTINED RUN REPLY" } } } });
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).not.toContain("QUARANTINED RUN REPLY");
    expect(result).not.toContain("QUARANTINED RUN SUMMARY");
    expect(result).toContain("Quarantined low-trust output omitted");
    expect(result).toContain(runId);
  });

  async function seedInteractionRun(lowTrust = false) {
    const id = randomUUID(), actorId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerInstanceId = randomUUID();
    await db.insert(agents).values({ id: actorId, companyId, name: "Historical question author", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id, companyId, title: "Question handoff", status: "in_progress", assigneeAgentId: actorId });
    const executionPolicy = lowTrust ? {
      trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
        trustBoundary: { mode: "low_trust_review", companyId, issueIds: [id] } },
    } : { trustPreset: "standard" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: actorId, status: "running", runtimeMode: "native",
      nativeIssueId: id, nativeSessionId: sessionId, runnerInstanceId, contextSnapshot: { issueId: id, executionPolicy } });
    return { id, agentId: actorId, runId, sessionId, runnerInstanceId };
  }

  async function answerHistoricalNativeQuestion(lowTrust: boolean, summaryMarkdown?: string) {
    const fixture = await seedInteractionRun(lowTrust);
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Reviewer", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "member" });
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", sourceEventId: "historical-question", sourceSeq: 1,
      sourceInstanceId: fixture.runnerInstanceId, sourceKind: "runner", runId: fixture.runId,
      normalizedSessionId: fixture.sessionId, turnId: "turn-1", itemId: "item-1",
      eventType: "runtime_request.created", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { request: { schema: "paperclip.runtime_request.v2", requestKind: "runtime", requestId: "question-1",
        type: "input", status: "pending", prompt: "HISTORICAL QUESTION BODY CANARY",
        input: { schema: "paperclip.question_set.v1", title: "HISTORICAL QUESTION TITLE CANARY", questions: [{
          id: "color", prompt: "Which color?", required: true, answerMode: "single_select",
          options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }],
        }] } } },
    };
    const interaction = await projectNativeRuntimeRequest({ db, event, binding: {
      companyId, issueId: fixture.id, agentId: fixture.agentId, runId: fixture.runId,
      normalizedSessionId: fixture.sessionId, runnerSourceInstanceId: fixture.runnerInstanceId,
    } });
    expect(interaction).not.toBeNull();
    const answered = await issueThreadInteractionService(db).answerQuestions({ id: fixture.id, companyId }, interaction!.id,
      { answers: [{ questionId: "color", optionIds: ["blue"] }], ...(summaryMarkdown === undefined ? {} : { summaryMarkdown }) },
      { userId });
    expect(answered.status).toBe("answered");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
    // The next dispatch is standard. Historical provenance must survive this policy change.
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, fixture.agentId));
    await db.update(issues).set({ executionPolicy: { trustPreset: "standard" } }).where(eq(issues.id, fixture.id));
    const result = await buildNativeSessionHandoff({ db, companyId, issueId: fixture.id, agentId: fixture.agentId, before: new Date() });
    expect(result).not.toBeNull();
    const packet = JSON.parse(result!.slice(result!.lastIndexOf("\n") + 1));
    const entry = packet.entries.find((value: { id: string }) => value.id === interaction!.id);
    return { fixture, result: result!, entry };
  }

  it.each([undefined, "HUMAN REVIEW SUMMARY"])("quarantines a low-trust native question after a human answer (%s)", async summary => {
    const { fixture, result, entry } = await answerHistoricalNativeQuestion(true, summary);
    expect(result).not.toContain("HISTORICAL QUESTION TITLE CANARY");
    expect(result).not.toContain("HISTORICAL QUESTION BODY CANARY");
    expect(entry).toMatchObject({ kind: "resolved_interaction", title: null,
      body: expect.stringContaining("Quarantined low-trust output omitted"),
      sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceRunId: fixture.runId, sourceAgentId: fixture.agentId } });
  });

  it("preserves a standard-run native question answered by a human", async () => {
    const { result, entry } = await answerHistoricalNativeQuestion(false);
    expect(result).toContain("HISTORICAL QUESTION TITLE CANARY");
    expect(result).toContain("HISTORICAL QUESTION BODY CANARY");
    expect(entry.sourceTrust).toBeNull();
  });

  it("preserves an interaction resolved by a standard agent run on another issue in the same company", async () => {
    const fixture = await seedInteractionRun();
    const resolver = await seedInteractionRun();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: fixture.id,
      kind: "ask_user_questions", status: "answered", createdByAgentId: fixture.agentId, sourceRunId: fixture.runId,
      resolvedByAgentId: resolver.agentId, resolvedByRunId: resolver.runId,
      title: "STANDARD CROSS-ISSUE DECISION", payload: { version: 1, questions: [] },
      result: { version: 1, summaryMarkdown: "STANDARD CROSS-ISSUE SUMMARY" }, resolvedAt: new Date(),
    }).returning({ id: issueThreadInteractions.id });
    const result = await buildNativeSessionHandoff({ db, companyId, issueId: fixture.id, agentId: fixture.agentId, before: new Date() });
    expect(result).toContain("STANDARD CROSS-ISSUE DECISION");
    expect(result).toContain("STANDARD CROSS-ISSUE SUMMARY");
    const packet = JSON.parse(result!.slice(result!.lastIndexOf("\n") + 1));
    expect(packet.entries.find((entry: { id: string }) => entry.id === interaction.id).sourceTrust).toBeNull();
  });

  const untrustedProvenance = ["missing", "wrong_company", "wrong_agent", "wrong_issue", "invalid_policy", "scalar_policy", "array_policy", "low_trust"] as const;
  it.each(untrustedProvenance.flatMap(provenance => (["creator", "resolver"] as const)
    .filter(actor => provenance !== "wrong_issue" || actor === "creator").map(actor => ({ provenance, actor }))))(
    "quarantines $actor interaction text with $provenance run provenance", async ({ provenance, actor }) => {
      const fixture = await seedInteractionRun();
      const suspectRunId = provenance === "missing" ? null : randomUUID();
      if (suspectRunId) {
        let runCompanyId = companyId, runAgentId = fixture.agentId, runIssueId = fixture.id;
        if (provenance === "wrong_company") {
          runCompanyId = randomUUID();
          await db.insert(companies).values({ id: runCompanyId, name: "Unrelated company", issuePrefix: `OTH${runCompanyId.slice(0, 8)}` });
        }
        if (provenance === "wrong_agent") {
          runAgentId = randomUUID();
          await db.insert(agents).values({ id: runAgentId, companyId, name: "Unrelated agent", adapterType: "paperclip_runner" });
        }
        if (provenance === "wrong_issue") {
          runIssueId = randomUUID();
          await db.insert(issues).values({ id: runIssueId, companyId, title: "Unrelated issue" });
        }
        const executionPolicy = provenance === "scalar_policy" ? "standard" : provenance === "array_policy" ? []
          : provenance === "invalid_policy" ? { trustPreset: "unknown" }
          : provenance === "low_trust" ? { trustPreset: "low_trust_review", authorizationPolicy: {
            trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, issueIds: [fixture.id] },
          } } : { trustPreset: "standard" };
        await db.insert(heartbeatRuns).values({ id: suspectRunId, companyId: runCompanyId, agentId: runAgentId,
          status: "succeeded", nativeIssueId: runIssueId, contextSnapshot: { issueId: runIssueId, executionPolicy } });
      }
      const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: fixture.id,
        kind: "ask_user_questions", status: "answered", createdByAgentId: fixture.agentId,
        sourceRunId: actor === "creator" ? suspectRunId : fixture.runId,
        resolvedByAgentId: actor === "resolver" ? fixture.agentId : null,
        resolvedByRunId: actor === "resolver" ? suspectRunId : null,
        title: "UNTRUSTED DECISION TITLE", summary: "UNTRUSTED DECISION BODY", payload: { version: 1, questions: [] },
        result: { version: 1, summaryMarkdown: "UNTRUSTED RESOLVER SUMMARY" }, resolvedAt: new Date(),
      }).returning({ id: issueThreadInteractions.id });
      const result = await buildNativeSessionHandoff({ db, companyId, issueId: fixture.id, agentId: fixture.agentId, before: new Date() });
      expect(result).not.toBeNull();
      expect(result).not.toContain("UNTRUSTED DECISION TITLE");
      expect(result).not.toContain("UNTRUSTED DECISION BODY");
      expect(result).not.toContain("UNTRUSTED RESOLVER SUMMARY");
      const packet = JSON.parse(result!.slice(result!.lastIndexOf("\n") + 1));
      expect(packet.entries.find((entry: { id: string }) => entry.id === interaction.id)).toMatchObject({ title: null,
        sourceTrust: { disposition: "quarantined", sourceRunId: suspectRunId, sourceAgentId: fixture.agentId } });
    });
});
