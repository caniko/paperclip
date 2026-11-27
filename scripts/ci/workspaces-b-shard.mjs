import { selectGeneralServerShard } from "../general-server-shard.mjs";

// Batched project timings (ms) from upstream paperclipai/paperclip@635ed5a36480.
// Adapter-utils takes about as long as the rest of the lane combined.
const projectDurations = {
  "@paperclipai/adapter-utils": 135_000,
  "@paperclipai/plugin-daytona": 34_000,
  "@paperclipai/adapter-claude-local": 20_000,
  "@paperclipai/adapter-codex-local": 17_500,
  "@paperclipai/adapter-gemini-local": 8_800,
  "@paperclipai/hermes-paperclip-adapter": 7_900,
  "@paperclipai/adapter-grok-local": 7_400,
  "@paperclipai/shared": 6_500,
  "@paperclipai/plugin-sdk": 6_000,
  "@paperclipai/adapter-opencode-local": 5_100,
  "@paperclipai/adapter-kimi-local": 5_000,
  "@paperclipai/adapter-openclaw-gateway": 4_100,
  "@paperclipai/adapter-cursor-local": 4_000,
  "@paperclipai/adapter-pi-local": 2_300,
  "@paperclipai/adapter-cursor-cloud": 2_300,
  "@paperclipai/skills-catalog": 1_600,
  "@paperclipai/create-paperclip-plugin": 700,
};

export function selectWorkspaceProjectsShard(projects, shardIndex, shardCount) {
  if (shardCount === null || shardCount <= 1) return projects;
  const durations = Object.fromEntries(projects.map((project) => [project, projectDurations[project] ?? 10_000]));
  const selected = new Set(selectGeneralServerShard(projects, shardIndex, shardCount, durations));
  return projects.filter((project) => selected.has(project));
}
