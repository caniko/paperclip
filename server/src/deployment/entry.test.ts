import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { paperclipConfigSchema } from "@paperclipai/shared";

const root = mkdtempSync(join(tmpdir(), "paperclip-deployment-entry-"));
const descriptorFile = join(root, "deployment.json");
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let port: number;
let child: ChildProcess | undefined;
let output = "";
const launch = (command: string) => spawn(process.execPath, [
  "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
  fileURLToPath(new URL("../deployment-entry.ts", import.meta.url)), descriptorFile, command,
], { env: { ...process.env, UNRELATED_TEST_SECRET: "must-not-reach-server" }, stdio: ["ignore", "pipe", "pipe"] });
async function command(name: string) {
  const process = launch(name); let stdout = "", stderr = "";
  process.stdout!.on("data", (chunk) => { stdout += chunk; });
  process.stderr!.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(process, "exit");
  return { code, stdout, stderr };
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  child = undefined;
}
beforeAll(async () => {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  port = address.port; await new Promise<void>((resolve) => socket.close(() => resolve()));
  database = await startEmbeddedPostgresTestDatabase("paperclip-deployment-entry-db-");
  const config = paperclipConfigSchema.parse({
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
    server: { deploymentMode: "authenticated", exposure: "private", host: "127.0.0.1", port, serveUi: false },
    auth: { baseUrlMode: "explicit", publicBaseUrl: `http://localhost:${port}`, disableSignUp: true },
    database: { mode: "postgres", backup: { enabled: false } },
    logging: { mode: "file", logDir: join(root, "logs") },
    telemetry: { enabled: false },
  });
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, owner: "entry", companies: { example: { fields: { name: "Entry test" } } } }));
  writeFileSync(join(root, "database"), database.connectionString, { mode: 0o600 });
  writeFileSync(join(root, "auth"), "entry-test-signing-secret-at-least-32-characters", { mode: 0o600 });
  writeFileSync(join(root, "password"), "entry-test-operator-password", { mode: 0o600 });
  writeFileSync(descriptorFile, JSON.stringify({ version: 1, home: root, instance: "entry", configFile: join(root, "config.json"),
    manifestFile: join(root, "manifest.json"), serverCredentials: { auth: join(root, "auth"), database: join(root, "database") },
    bootstrap: { email: "operator@example.test", name: "Entry operator", passwordFile: join(root, "password") } }));
}, 90000);
afterAll(async () => { await stop(); await database?.cleanup(); rmSync(root, { recursive: true, force: true }); });

it("runs the real launcher, authenticates, plans read-only and fences online apply", async () => {
  child = launch("serve");
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child?.exitCode !== null) throw new Error(`Launcher exited: ${output}`);
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status; } catch { return 0; }
  }, { timeout: 45000, interval: 500 }).toBe(200);
  const response = await fetch(`http://localhost:${port}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
    body: JSON.stringify({ email: "operator@example.test", password: "entry-test-operator-password" }),
  });
  expect(response.status, await response.text()).toBe(200);
  const plan = await command("plan");
  expect(plan.code, plan.stderr).toBe(0);
  expect(JSON.parse(plan.stdout).differences).toEqual([]);
  expect((await command("check")).code).toBe(0);
  expect((await command("apply")).code).toBe(1);
  const environment = readFileSync(`/proc/${child!.pid}/environ`, "utf8");
  expect(environment).not.toContain("entry-test-signing-secret");
  expect(output).not.toContain("entry-test-signing-secret");
  expect(output).not.toContain("entry-test-operator-password");
  await stop();
  expect((await command("apply")).code).toBe(0);
}, 120000);

it("refuses invalid provisioning before opening a listener", async () => {
  await stop();
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 99, owner: "entry", companies: {} }));
  const failed = await command("serve");
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("declarative startup failed");
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
}, 30000);
