import { Server } from "node:net";
import { pathToFileURL } from "node:url";

// Node's IPC server-handle transfer keeps the fixture's assigned socket bound
// across process startup. The generated gateway still validates its assigned
// positive port and runs its real request, readiness, and HTTP/2 code.
process.once("message", async ({ entrypoint, port }, listener) => {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (assignedPort, host, callback) {
    Server.prototype.listen = listen;
    if (assignedPort !== port || host !== "127.0.0.1" || !(listener instanceof Server)) {
      throw new Error("Gateway did not adopt its reserved loopback listener");
    }
    return listen.call(this, listener, callback);
  };
  try {
    await import(pathToFileURL(entrypoint).href);
  } finally {
    Server.prototype.listen = listen;
    process.disconnect();
  }
});
