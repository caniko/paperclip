import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lock policy consumes large diffs and accepts only unchanged canonical imports", t => {
  const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Block manual lockfile edits")[1].split("      - name:")[0];
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "")
    .replaceAll("${{ github.event.pull_request.base.sha }}", "base").replaceAll("${{ github.event.pull_request.head.sha }}", "head");
  const directory = mkdtempSync(join(tmpdir(), "pr-lock-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "git"), `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "diff" && args[1] === "--name-only") console.log((process.env.LOCK_CHANGED === "true" ? "pnpm-lock.yaml\\n" : "") + Array.from({length:50000},(_,i)=>"changed/"+i).join("\\n"));
else if (args[0] === "fetch") { writeFileSync(process.env.FETCH_STATE, args.at(-1)); process.exit(process.env.FETCH_FAILED === "true" || (process.env.REFRESH_FETCH_FAILED === "true" && args.at(-1) !== "master") ? 1 : 0); }
else if (args[0] === "merge-base") console.log("a".repeat(40));
else if (args[0] === "rev-parse") { if (process.env.RESOLVE_FAILED === "true") process.exit(1); console.log(args[1].startsWith("head:") ? (process.env.MANUAL_LOCK === "true" ? "c" : "b").repeat(40) : (process.env.REFRESH_LOCK === "true" && readFileSync(process.env.FETCH_STATE, "utf8") === "master" ? "d" : "b").repeat(40)); }
else process.exit(2);
`, { mode: 0o700 });
  for (const [changed, manual, fetchFailed, resolveFailed, refresh, refreshFetchFailed, succeeds] of [[false, false, false, false, false, false, true], [true, false, false, false, false, false, true], [true, true, false, false, false, false, false], [true, false, true, false, false, false, false], [true, false, false, true, false, false, false], [true, false, false, false, true, false, true], [true, true, false, false, true, false, false], [true, false, false, false, true, true, false]]) {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FETCH_STATE: join(directory, "fetched-ref"), LOCK_CHANGED: String(changed), MANUAL_LOCK: String(manual), FETCH_FAILED: String(fetchFailed), RESOLVE_FAILED: String(resolveFailed), REFRESH_LOCK: String(refresh), REFRESH_FETCH_FAILED: String(refreshFetchFailed) } });
    assert.equal(result.status === 0, succeeds, `${JSON.stringify({changed, manual, fetchFailed, refresh, refreshFetchFailed})}: ${result.stdout} ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Broken pipe/);
    if (manual) assert.match(result.stdout, /Do not commit pnpm-lock.yaml/);
  }
});
