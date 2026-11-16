import { describe, expect, it } from "vitest";
import { buildOpenCodeRunArgs } from "./run-args.js";

// `opencode run --help` flags of opencode v2.2.5+f5c7fa1.
const V2_RUN_FLAGS = new Set([
  "--continue", "--session", "--fork", "--model", "--agent", "--format", "--file", "--title", "--thinking",
  "--auto", "--log-level", "--print-logs", "--standalone", "--server",
]);

describe("buildOpenCodeRunArgs", () => {
  it("builds an argv that opencode v2 run accepts", () => {
    const args = buildOpenCodeRunArgs({
      model: "opencode-go/deepseek-v4.1-flash",
      variant: "max",
      extraArgs: ["--agent", "paperclip-junior"],
      resumeSessionId: "ses_123",
      printLogs: true,
    });
    expect(args).toEqual([
      "run", "--format", "json", "--print-logs", "--session", "ses_123",
      "--model", "opencode-go/deepseek-v4.1-flash#max", "--standalone", "--agent", "paperclip-junior",
    ]);
    expect(args.filter((arg) => arg.startsWith("--") && !V2_RUN_FLAGS.has(arg))).toEqual([]);
  });

  it("keeps an operator-selected server and an explicit model variant", () => {
    expect(buildOpenCodeRunArgs({ model: "a/b#low", variant: "high", extraArgs: ["--server=http://x", "--", "--standalone"] }))
      .toEqual(["run", "--format", "json", "--model", "a/b#low", "--server=http://x", "--", "--standalone"]);
    expect(buildOpenCodeRunArgs({ model: "", variant: "high", extraArgs: ["--standalone"] }))
      .toEqual(["run", "--format", "json", "--standalone"]);
  });
});
