import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in native coverage uses real runnerd with the repo's deterministic Codex
// protocol fixture. Never let this suite fall through to a logged-in real Codex.
const fixture = process.env.PAPERCLIP_STOP_FAKE_CODEX;
if (process.env.PAPERCLIP_STOP_REQUIRE_NATIVE === "true") {
  const sourceRoot = process.env.PAPERCLIP_E2E_SOURCE_ROOT;
  if (!sourceRoot || !path.isAbsolute(sourceRoot) || !fs.statSync(sourceRoot).isDirectory())
    throw new Error("Mandatory native composer Stop requires an absolute candidate source root");
  for (const binary of [fixture, process.env.PAPERCLIP_RUNNER_BINARY]) {
    if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile())
      throw new Error("Mandatory native composer Stop requires both absolute binary paths");
    fs.accessSync(binary, fs.constants.X_OK);
  }
}
const fixtureDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "composer-stop-provider-"),
);
const logPath =
  process.env.PAPERCLIP_STOP_CODEX_LOG ??
  path.join(fixtureDir, "codex-calls.log");
process.env.PAPERCLIP_STOP_CODEX_LOG = logPath;
if (fixture) {
  if (!path.isAbsolute(fixture) || !fs.existsSync(fixture))
    throw new Error(
      "PAPERCLIP_STOP_FAKE_CODEX must name the built fake-codex-app-server binary",
    );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    path.join(fixtureDir, "codex"),
    `#!/bin/sh\nexec ${quote(fixture)} --state-file ${quote(fixtureDir)}/state-$$.json --hold-turn --call-log ${quote(logPath)} "$@"\n`,
    { mode: 0o755 },
  );
}
const server = base.webServer as Exclude<typeof base.webServer, unknown[]>;
const browserExecutable = process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH;
export default defineConfig({
  ...base,
  // Nix development hosts may have a wrapped Chromium with the runtime
  // libraries that the downloaded Playwright shell does not include.
  ...(browserExecutable ? {
    projects: base.projects?.map((project) => ({
      ...project,
      use: { ...project.use, launchOptions: { executablePath: browserExecutable } },
    })),
  } : {}),
  testMatch: "composer-stop.spec.ts",
  timeout: 90_000,
  webServer: {
    ...server,
    env: {
      ...server?.env,
      HEARTBEAT_SCHEDULER_INTERVAL_MS: "10000",
      PATH: `${fixtureDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  },
});
