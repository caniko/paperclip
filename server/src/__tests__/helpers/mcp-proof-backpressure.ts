import express from "express";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";

/** Real HTTP pipelining: the proof response is queued behind an unfinished,
 * backpressured response while the client deliberately reads no responses. */
export async function exerciseMcpProofBackpressure(app: express.Express, proof: {
  path: string; bearerToken: string; signature: string;
}, timeoutMs = 2000) {
  const outer = express();
  let backpressured = false, serverSocket: Socket | undefined;
  outer.get("/fixture-backpressure", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    // A fixed buffer is sufficient to exceed Node's write high-water mark;
    // the first response intentionally stays open after this bounded write.
    backpressured = !res.write(Buffer.alloc(128 * 1024, 65));
  });
  outer.use(app);
  const server = createServer(outer);
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  server.on("connection", socket => {
    serverSocket = socket;
    socket.once("close", closed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const client = connect(port, "127.0.0.1");
  client.on("error", () => undefined);
  client.pause();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(client, "connect");
    const body = JSON.stringify({ signature: proof.signature });
    client.write(["GET /fixture-backpressure HTTP/1.1", "Host: 127.0.0.1", "", "",
      `POST ${proof.path} HTTP/1.1`, "Host: 127.0.0.1", `Authorization: Bearer ${proof.bearerToken}`,
      "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "", body].join("\r\n"));
    await Promise.race([disconnected, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("Proof ingress left a backpressured response beyond its transport bound")), timeoutMs);
    })]);
    return { backpressured, serverSocketDestroyed: serverSocket?.destroyed === true };
  } finally {
    clearTimeout(deadline);
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
