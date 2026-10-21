import { and, eq, isNull, or, sql } from "drizzle-orm";
import { adapterSessionAffinities, agentTaskSessions, agents, type Db } from "@paperclipai/db";

export interface ExecutionAffinityBinding {
  companyId: string;
  agentId: string;
  adapterType: string;
  scopeKey: string;
  generation: number;
  endpoint: string | null;
}

/** Read a durable conversation binding, adopting only unambiguous old session evidence. */
export async function loadExecutionAffinity(db: Db, input: {
  companyId: string; agentId: string; adapterType: string; scope: "agent" | "issue";
  taskKey: string | null; primaryEndpoint: string;
  runtime?: { sessionId: string | null; sessionParams: Record<string, unknown> | null };
}): Promise<ExecutionAffinityBinding> {
  const scopeKey = input.scope === "agent" ? "agent" : `issue:${input.taskKey}`;
  return db.transaction(async (tx) => {
    const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
    )).for("no key update");
    if (!agent) throw new Error("Executor affinity agent is outside the company");
    let [binding] = await tx.select().from(adapterSessionAffinities).where(and(
      eq(adapterSessionAffinities.companyId, input.companyId), eq(adapterSessionAffinities.agentId, input.agentId),
      eq(adapterSessionAffinities.adapterType, input.adapterType), eq(adapterSessionAffinities.scopeKey, scopeKey),
    ));
    if (!binding) {
      const sessions = await tx.select().from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.adapterType, input.adapterType),
        input.scope === "agent" ? sql`coalesce(${agentTaskSessions.sessionParamsJson}->>'strategy', 'agent') = 'agent'`
          : eq(agentTaskSessions.taskKey, input.taskKey!),
      ));
      const historicalSessions = sessions.filter(row => row.sessionParamsJson || row.sessionDisplayId);
      const endpoints = new Set(historicalSessions.map(row => row.sessionParamsJson?.executorBaseUrl ?? input.primaryEndpoint));
      const runtime = input.runtime;
      if (runtime && (runtime.sessionId || runtime.sessionParams)
        && (!runtime.sessionParams?.strategy || runtime.sessionParams.strategy === input.scope)) {
        endpoints.add(runtime.sessionParams?.executorBaseUrl ?? input.primaryEndpoint);
      }
      if (endpoints.size > 1 || [...endpoints].some(endpoint => typeof endpoint !== "string")) {
        throw new Error("Conflicting conversation executor history; explicitly reset the session");
      }
      const endpoint = [...endpoints][0];
      [binding] = await tx.insert(adapterSessionAffinities).values({
        companyId: input.companyId, agentId: input.agentId, adapterType: input.adapterType,
        scopeKey, taskKey: input.scope === "issue" ? input.taskKey : null,
        endpoint: typeof endpoint === "string" ? endpoint : null,
      }).returning();
    }
    return { companyId: input.companyId, agentId: input.agentId, adapterType: input.adapterType,
      scopeKey, generation: binding!.generation, endpoint: binding!.endpoint };
  });
}

/** Keep reset rows as generation tombstones so an in-flight admission cannot restore a pin. */
export async function resetExecutionAffinities(db: Db, companyId: string, agentId: string, taskKeys?: string[]) {
  await db.transaction(async tx => {
    await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("no key update");
    await tx.update(adapterSessionAffinities).set({ endpoint: null,
      generation: sql`${adapterSessionAffinities.generation} + 1`, updatedAt: new Date(),
    }).where(and(eq(adapterSessionAffinities.companyId, companyId), eq(adapterSessionAffinities.agentId, agentId),
      taskKeys ? or(isNull(adapterSessionAffinities.taskKey), ...taskKeys.map(key => eq(adapterSessionAffinities.taskKey, key))) : undefined));
  });
}
