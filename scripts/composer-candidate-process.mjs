import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { verifyComposerCandidateRuntime } from "./composer-candidate-runtime.mjs";

const observed = new Map();

export function composerCandidateProcessAlive(pid, env = process.env) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647, "Invalid process ID");
  if (!env.COMPOSER_STOP_CONTAINER_ID && env.PAPERCLIP_STOP_REQUIRE_NATIVE !== "true") {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  }
  verifyComposerCandidateRuntime(env);
  const output = execFileSync("docker", ["exec", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", env.COMPOSER_STOP_CONTAINER_ID,
    "/usr/local/bin/node", "-e", `try {
      const stat = require("node:fs").readFileSync("/proc/${pid}/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      process.stdout.write(JSON.stringify([fields[0], fields[19]]));
    } catch (error) { if (error.code !== "ENOENT") throw error; process.stdout.write("null"); }`],
  { encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
  const identity = JSON.parse(output);
  if (identity === null) return false;
  assert.ok(Array.isArray(identity) && identity.length === 2 && /^[A-Za-z]$/.test(identity[0]) && /^\d+$/.test(identity[1]), "Invalid container process identity");
  const key = `${env.COMPOSER_STOP_CONTAINER_ID}:${pid}`;
  if (!observed.has(key)) observed.set(key, identity[1]);
  return observed.get(key) === identity[1] && !["Z", "X"].includes(identity[0]);
}
