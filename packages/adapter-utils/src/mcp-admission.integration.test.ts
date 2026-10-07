import http from "node:http";
import { expect, it } from "vitest";
import { bindMcpServersToRun, requireMcpRunBinding } from "./mcp-admission.js";

it("uses the same admission metadata for an unrelated authenticated MCP service", async () => {
  const observed: Array<{ authorization: string | undefined; method: string }> = [];
  const service = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    observed.push({ authorization: request.headers.authorization, method: rpc.method });
    response.writeHead(request.headers.authorization === "Bearer fixture-reader" ? 200 : 403,
      { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {
      content: [{ type: "text", text: "unrelated-service-result" }],
    } }));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  try {
    const address = service.address();
    if (!address || typeof address === "string") throw new Error("fixture failed to bind");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const [server] = bindMcpServersToRun({
      servers: [{ connectionId: "weather-reader", name: "Weather lookup", url: endpoint, token: "fixture-reader" }],
      runId: "weather-run", executionHostId: "fixture-host", policy: { version: 1, servers: {
        "weather-reader": { url: endpoint, gatewayUrl: endpoint, serverHostId: "fixture-host", executionHostIds: ["fixture-host"] },
      } },
    });
    // A separate service consumer uses exact identity and recipient matching;
    // it has no Hermes aliases, wire manifest, capabilities or tool namespace.
    requireMcpRunBinding(server.runBinding, { runId: "weather-run", executionHostId: "fixture-host", gatewayUrl: endpoint });
    const response = await fetch(server.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2_000),
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "weather_lookup", arguments: { city: "Oslo" } } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { content: [{ text: "unrelated-service-result" }] } });
    expect(() => requireMcpRunBinding(server.runBinding, { runId: "another-run", executionHostId: "fixture-host", gatewayUrl: endpoint })).toThrow();
    expect(observed).toEqual([{ authorization: "Bearer fixture-reader", method: "tools/call" }]);
    expect(server.name).toBe("Weather lookup");
  } finally {
    service.closeAllConnections();
    await new Promise<void>((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
  }
});
