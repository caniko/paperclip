import { randomUUID } from "node:crypto";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

type Target = { runId: string; target: AdapterExecutionTarget; command: string; cwd: string };
type Registration = { url: string; password: string; pid: number; backendID: string; generation: string };

const targetControl = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { operation, command, ...input } = JSON.parse(fs.readFileSync(0, "utf8"));
const cli = (args, env) => execFileSync(command, args, { env, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const read = (file) => fs.readFileSync(file, "utf8");
const versionOK = (version) => /^2\.3\.2(?:\+[a-zA-Z0-9.-]+)?$/.test(version);
function origin(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.href !== parsed.origin + "/") throw Error("Not a loopback service origin");
  return parsed.origin;
}
async function request(connection, route, method, payload, timeoutMs = 3500) {
  if (!route.startsWith("/api/")) throw Error("Invalid OpenCode API route");
  const response = await fetch(origin(connection.url) + route, {
    method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: "Basic " + Buffer.from("opencode:" + connection.password).toString("base64"),
      "content-type": "application/json", "x-opencode-capabilities": "experimental-media-uri",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: response.ok && response.status !== 204 ? await response.json() : undefined };
}
async function check(connection) {
  const { status, body } = await request(connection, "/api/info");
  if (status !== 200 || body.pid !== connection.pid || !versionOK(body.version)) throw Error("OpenCode instance changed");
}
function processGeneration(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Invalid OpenCode pid");
  const stat = read("/proc/" + pid + "/stat");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return read("/proc/sys/kernel/random/boot_id").trim() + ":" + pid + ":" + start;
}
function environment(pid) {
  const inherited = Object.fromEntries(read("/proc/" + pid + "/environ").split("\0").filter(Boolean).map((entry) => {
    const equal = entry.indexOf("=");
    return [entry.slice(0, equal), entry.slice(equal + 1)];
  }));
  if (!inherited.PATH || !inherited.HOME) throw Error("OpenCode base environment is unavailable");
  const { XDG_STATE_HOME, ...saved } = JSON.parse(cli(["service", "get", "env"], inherited));
  return { ...inherited, ...saved };
}
function databaseID(pid, env) {
  const db = cli(["debug", "paths", "db"], env);
  if (!path.isAbsolute(db)) throw Error("Managed OpenCode requires a persistent database");
  const stat = fs.statSync(db, { bigint: true });
  const fds = "/proc/" + pid + "/fd";
  const open = fs.readdirSync(fds).some((fd) => {
    try {
      const opened = fs.statSync(path.join(fds, fd), { bigint: true });
      return opened.dev === stat.dev && opened.ino === stat.ino;
    } catch { return false; }
  });
  if (!stat.isFile() || !open) throw Error("OpenCode is not using the expected database");
  const identity = [read("/etc/machine-id").trim(), fs.realpathSync(db), stat.dev, stat.ino, stat.birthtimeNs].join("\0");
  return "upstream:" + createHash("sha256").update(identity).digest("hex");
}
async function main() {
  if (operation === "discover") {
    const url = origin(cli(["service", "status"]));
    const state = cli(["debug", "paths", "state"]);
    const candidates = fs.readdirSync(state).filter((name) => /^service(?:-[\w.-]+)?\.json$/.test(name));
    for (const name of candidates) {
      let registration;
      try {
        registration = JSON.parse(read(path.join(state, name)));
        if (origin(registration.url) !== url || typeof registration.password !== "string" || !registration.password) continue;
        await check(registration);
      } catch { continue; }
      const { pid, password } = registration;
      const generation = processGeneration(pid);
      const backendID = databaseID(pid, environment(pid));
      if (generation !== processGeneration(pid)) throw Error("OpenCode instance changed");
      return { url, password, pid, generation, backendID };
    }
    throw Error("No authenticated OpenCode registration");
  }
  if (operation === "environment") {
    if (input.generation !== processGeneration(input.pid)) throw Error("OpenCode instance changed");
    const env = environment(input.pid);
    await check(input);
    if (input.generation !== processGeneration(input.pid)) throw Error("OpenCode instance changed");
    const result = await request(input, input.route, "PUT", { variables: { ...env, ...input.variables } });
    if (result.status !== 204) throw Error("Cannot set OpenCode session environment");
    await check(input);
    return;
  }
  if (operation === "request") return request(input, input.route, input.method, input.payload);
  throw Error("Unknown control operation");
}
main().then((result) => { if (result !== undefined) process.stdout.write(JSON.stringify(result)); })
  .catch(() => { process.exitCode = 1; });
`;

async function runOnTarget(base: Target, input: object) {
  const result = await runAdapterExecutionTargetProcess(
    `${base.runId}:opencode-control:${randomUUID()}`, base.target, "node", ["-e", targetControl], {
      cwd: base.cwd,
      env: {},
      stdin: JSON.stringify({ command: base.command, ...input }),
      timeoutSec: 15,
      graceSec: 2,
      onLog: async () => {},
    },
  );
  if (result.exitCode !== 0 || result.signal || result.timedOut)
    throw new Error("Managed OpenCode service discovery or control failed");
  return result.stdout ? JSON.parse(result.stdout) as unknown : undefined;
}

export class OpenCodeHttpError extends Error {
  constructor(readonly status: number) {
    super(`Managed OpenCode HTTP request failed (${status})`);
  }
}

export async function discoverManagedService(base: Target) {
  const raw = parseObject(await runOnTarget(base, { operation: "discover" }));
  if (typeof raw.url !== "string" || typeof raw.password !== "string" || !raw.password ||
    typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 0 ||
    typeof raw.backendID !== "string" || !raw.backendID.startsWith("upstream:") ||
    typeof raw.generation !== "string" || !raw.generation)
    throw new Error("Invalid managed OpenCode registration");
  const connection = raw as Registration;
  const origin = new URL(connection.url);
  if (!["http:", "https:"].includes(origin.protocol) ||
    !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.href !== `${origin.origin}/`)
    throw new Error("Managed OpenCode requires a loopback service URL on the execution target");

  async function request(route: string, method = "GET", payload?: unknown): Promise<unknown> {
    if (!route.startsWith("/api/")) throw new Error("Invalid managed OpenCode API route");
    if (base.target.kind === "remote") {
      const response = parseObject(await runOnTarget(base, { operation: "request", ...connection, route, method, payload }));
      if (typeof response.status !== "number" || response.status < 200 || response.status >= 300)
        throw new OpenCodeHttpError(typeof response.status === "number" ? response.status : 0);
      return response.body;
    }
    const response = await fetch(new URL(route, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(3500),
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`,
        "content-type": "application/json",
        "x-opencode-capabilities": "experimental-media-uri",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) throw new OpenCodeHttpError(response.status);
    return response.status === 204 ? undefined : await response.json();
  }

  return {
    backendID: connection.backendID,
    generation: connection.generation,
    request,
    async assertCurrent() {
      const info = parseObject(await request("/api/info"));
      if (info.pid !== connection.pid || typeof info.version !== "string" || !/^2\.3\.2(?:\+[a-zA-Z0-9.-]+)?$/.test(info.version))
        throw new Error("Managed OpenCode service generation changed");
    },
    async setEnvironment(route: string, variables: Record<string, string>) {
      await runOnTarget(base, { operation: "environment", ...connection, route, variables });
    },
  };
}

export type ManagedService = Awaited<ReturnType<typeof discoverManagedService>>;
