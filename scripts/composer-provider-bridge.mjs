import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";

// The trusted caller supplies all paths. Only the socket crosses into the
// candidate container; provider code, state and call-log write authority do not.
export async function startComposerProviderBridge({ socketPath, provider, callLog, stateDirectory }) {
  for (const path of [socketPath, provider, callLog, stateDirectory]) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Provider bridge requires absolute trusted paths");
  }
  const clients = new Map();
  const server = createServer({ allowHalfOpen: true }, socket => {
    // ponytail: this fixture allows four clients, 1 MiB per session and 60s idle;
    // larger acceptance scenarios need explicitly reviewed bounds.
    if (clients.size >= 4) { socket.destroy(); return; }
    const child = spawn(provider, ["--state-file", join(stateDirectory, `${randomUUID()}.json`),
      "--hold-turn", "--call-log", callLog], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = new Promise(resolve => child.once("close", () => {
      clients.delete(socket);
      socket.end();
      resolve();
    }));
    clients.set(socket, { child, closed });
    let received = 0;
    socket.on("data", chunk => {
      received += chunk.length;
      if (received > 1024 * 1024) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    child.on("error", () => socket.destroy());
    child.stdin.on("error", () => socket.destroy());
    // Keep the client slot until the process has exited, not merely disconnected.
    socket.once("close", () => child.kill("SIGTERM"));
    socket.setTimeout(60_000, () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const processes = [...clients.values()].map(client => client.closed);
      for (const [socket, { child }] of clients) { socket.destroy(); child.kill("SIGTERM"); }
      await Promise.all([closed, ...processes]);
    },
  };
}
