import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createServer, get as httpsGet } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { MemoryAuditSink } from "../../../../packages/tailscale-https-broker/src/audit.js";
import { BrokerCore, type CliResult } from "../../../../packages/tailscale-https-broker/src/broker-core.js";
import { createPeerResolver } from "../../../../packages/tailscale-https-broker/src/peercred.js";
import { defaultIsAllowedPort } from "../../../../packages/tailscale-https-broker/src/port-policy.js";
import { createProcListenerVerifier } from "../../../../packages/tailscale-https-broker/src/proc-listener.js";
import { startSocketServer } from "../../../../packages/tailscale-https-broker/src/socket-server.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Mock only Tailscale Serve and network routing; keep the real broker and TLS. */
export async function startMockTailscaleBroker() {
  assert.equal(process.platform, "linux", "The broker fixture requires real Linux peer credentials and /proc");
  const uid = process.getuid!();
  const gid = process.getgid!();
  const directory = await mkdtemp(path.join(tmpdir(), "paperclip-ts-mock-"));
  const hostname = `fixture-${randomUUID()}.tailnet.test.ts.net`;
  const socketPath = path.join(directory, "broker.sock");
  const registryPath = path.join(directory, "registry.json");
  const primary = "http://127.0.0.1:3100";
  const ports = new Map<number, string>([[443, primary]]);
  const audit = new MemoryAuditSink();
  const priorSocket = process.env.PAPERCLIP_TAILSCALE_BROKER_SOCKET;
  const priorHostname = process.env.PAPERCLIP_TAILSCALE_DNS_NAME;
  let broker: Server | undefined;
  let restoreFetch = () => {};
  const gateway = createServer();
  const close = async (server: Server) => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  const dispose = async () => {
    restoreFetch();
    for (const [name, value] of [["PAPERCLIP_TAILSCALE_BROKER_SOCKET", priorSocket], ["PAPERCLIP_TAILSCALE_DNS_NAME", priorHostname]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    gateway.closeAllConnections();
    try { if (broker) await close(broker); }
    finally { try { await close(gateway); } finally { await rm(directory, { recursive: true, force: true }); } }
  };
  try {
    const openssl = realpathSync(execFileSync("which", ["openssl"], { encoding: "utf8", timeout: 5_000 }).trim());
    const certPath = path.join(directory, "cert.pem");
    const keyPath = path.join(directory, "key.pem");
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
      "-keyout", keyPath, "-out", certPath], { stdio: "pipe", timeout: 15_000 });
    const cert = readFileSync(certPath);
    gateway.setSecureContext({ key: readFileSync(keyPath), cert });
    gateway.on("request", (request, response) => {
      const authority = request.headers.host ?? "";
      const port = Number(authority.slice(hostname.length + 1));
      if (request.method !== "GET" || request.url !== "/api/health"
        || authority !== `${hostname}:${port}` || port === 443 || !ports.has(port)) {
        response.writeHead(404).end();
        return;
      }
      const upstream = httpGet(new URL(request.url ?? "/", ports.get(port)), { agent: false }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      upstream.on("error", () => response.writeHead(502).end());
      response.on("close", () => upstream.destroy());
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const gatewayPort = (gateway.address() as AddressInfo).port;
    // Node's HTTPS client still verifies the original SNI/hostname and chain.
    // Only this fixture trusts its certificate; global TLS settings are untouched.
    const fetchTls = (url: URL, ca?: Buffer, signal?: AbortSignal | null) => new Promise<Response>((resolve, reject) => {
      const request = httpsGet(url, { hostname: "127.0.0.1", port: gatewayPort, servername: url.hostname,
        headers: { host: url.host }, ca, rejectUnauthorized: true, agent: false,
        signal: signal ?? AbortSignal.timeout(5_000) }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve(new Response(Buffer.concat(chunks).toString("utf8"), { status: response.statusCode })));
      });
      request.on("error", reject);
    });
    await expect(fetchTls(new URL(`https://${hostname}/api/health`))).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    await expect(fetchTls(new URL("https://wrong.tailnet.test.ts.net/api/health"), cert)).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    const nativeModule = new URL("../../../../packages/tailscale-https-broker/dist/native-peercred.js", import.meta.url);
    const { createNativePeerCredentialReader } = await import(nativeModule.href);
    const resolvePeer = vi.fn(createPeerResolver({ soPeercred: createNativePeerCredentialReader() }));
    const verifyListenerOwnership = vi.fn(createProcListenerVerifier(uid));
    const bin = "/mock/tailscale";
    const runTailscale = vi.fn((argv: string[]): CliResult => {
      if (argv[2] === "status") {
        assert.deepEqual(argv, [bin, "serve", "status", "--json"]);
        return { code: 0, stderr: "", timedOut: false, stdout: JSON.stringify({
          TCP: Object.fromEntries([...ports.keys()].map(port => [port, { HTTPS: true }])),
          Web: Object.fromEntries([...ports].map(([port, target]) => [`${hostname}:${port}`, { Handlers: { "/": { Proxy: target } } }])),
        }) };
      }
      const expose = argv[2] === "--bg";
      const port = Number((expose ? argv[3] : argv[2])?.replace("--https=", ""));
      assert.ok(defaultIsAllowedPort(port), "The mock cannot publish protected or unrelated ports");
      assert.deepEqual(argv, expose ? [bin, "serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]
        : [bin, "serve", `--https=${port}`, "off"]);
      if (expose) ports.set(port, `http://127.0.0.1:${port}`);
      else ports.delete(port);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    broker = startSocketServer({ socketPath, serviceUid: uid, resolvePeer, core: new BrokerCore({
      tailscaleBinPath: bin, registryPath, nodeIdentity: hostname, auditSink: audit,
      peerPolicy: { allowedUids: new Set([uid]), allowedGids: new Set([gid]) },
      isAllowedPort: defaultIsAllowedPort,
      deps: { runTailscale, verifyListenerOwnership, nowIso: () => new Date().toISOString() },
    }) });
    await once(broker, "listening");
    process.env.PAPERCLIP_TAILSCALE_BROKER_SOCKET = socketPath;
    process.env.PAPERCLIP_TAILSCALE_DNS_NAME = hostname;
    const originalFetch = globalThis.fetch;
    const routedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== hostname) return originalFetch(input, init);
      assert.equal(url.protocol, "https:");
      assert.equal(init?.method ?? (input instanceof Request ? input.method : "GET"), "GET");
      return fetchTls(url, cert, init?.signal ?? (input instanceof Request ? input.signal : undefined));
    });
    restoreFetch = () => routedFetch.mockRestore();
    return { async cleanup() {
      try {
        expect([...ports]).toEqual([[443, primary]]);
        const registry = JSON.parse(readFileSync(registryPath, "utf8"));
        expect(registry.leases).toEqual([]);
        expect(registry.quarantinedPorts).toEqual([]);
        expect(runTailscale.mock.calls.filter(([argv]) => argv[2] === "--bg")).toHaveLength(2);
        expect(runTailscale.mock.calls.filter(([argv]) => argv[3] === "off")).toHaveLength(2);
        expect(resolvePeer.mock.calls.length).toBeGreaterThan(0);
        expect(resolvePeer.mock.results.every(result => result.type === "return" && result.value.uid === uid && result.value.gid === gid)).toBe(true);
        expect(verifyListenerOwnership.mock.results.some(result => result.type === "return" && result.value.present
          && result.value.loopbackOnly && result.value.ownerUidMatches && result.value.inodes.length > 0)).toBe(true);
        expect(routedFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
        const receipt = { schema: "paperclip.mocked-tailscale-exercise.v1", providerMocked: true, liveProviderVerified: false,
          platform: process.platform, hostname, nativePeerCredentialsVerified: true, procOwnershipVerified: true,
          untrustedCertificateRejected: true, wrongHostnameRejected: true, primaryPreserved: true, cleanupPassed: true,
          exposedListeners: 2, removedListeners: 2, httpsRequests: routedFetch.mock.calls.filter(([input]) =>
            new URL(input instanceof Request ? input.url : String(input)).hostname === hostname).length,
          certificateSha256: sha256(cert), openssl, opensslSha256: sha256(readFileSync(openssl)),
          opensslVersion: execFileSync(openssl, ["version"], { encoding: "utf8", timeout: 5_000 }).trim(),
          nativeAddonSha256: sha256(readFileSync(new URL("peercred-native.node", nativeModule))),
          fixtureSha256: sha256(readFileSync(new URL(import.meta.url))),
          producerAcceptanceQualified: false };
        if (process.env.EVIDENCE) writeFileSync(path.join(process.env.EVIDENCE, "tailscale-mock.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
        console.log("[mocked Tailscale exercise]", JSON.stringify(receipt));
      } finally { await dispose(); }
    } };
  } catch (error) {
    await dispose();
    throw error;
  }
}
