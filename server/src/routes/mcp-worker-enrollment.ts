import type { RequestHandler } from "express";
import { mcpWorkerEnrollmentProofSchema } from "@paperclipai/shared";
import type { mcpWorkerEnrollmentService } from "../services/mcp-worker-enrollment.js";
import { McpLaunchBlockedError } from "../services/mcp-prepared-launch-contract.js";

type Service = Pick<ReturnType<typeof mcpWorkerEnrollmentService>, "authenticateBootstrap" | "prove">;
const proofPath = /^\/mcp\/worker-enrollments\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/proof$/i;
const defaults = Object.freeze({ bodyBytes: 1024, deadlineMs: 30_000, inFlight: 8, clientKeys: 1024, requestsPerWindow: 30 });
const WINDOW_MS = 60_000;

/** Only this exact POST uses bootstrap auth. Mount after trust-proxy setup and
 * before global parsing/logging/actor auth. No board credential substitutes it. */
export function mcpWorkerEnrollmentProofRoutes(service: Service, hostnameGuard: RequestHandler,
  limits: Partial<typeof defaults> = {}): RequestHandler {
  const policy = { ...defaults, ...limits };
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > defaults[key]) throw new Error("Invalid worker proof ingress limit");
  }
  const clients = new Map<string, { startsAt: number; attempts: number }>();
  let inFlight = 0;
  function admit(ip: string) {
    const now = Date.now();
    for (const [key, entry] of clients) if (entry.startsAt + WINDOW_MS <= now) clients.delete(key);
    let entry = clients.get(ip);
    if (!entry) {
      if (clients.size >= policy.clientKeys) return false;
      entry = { startsAt: now, attempts: 0 };
      clients.set(ip, entry);
    }
    entry.attempts += 1;
    if (entry.attempts > policy.requestsPerWindow || inFlight >= policy.inFlight) return false;
    inFlight += 1;
    return true;
  }
  return (req, res, next) => {
    const match = req.method === "POST" ? proofPath.exec(req.path) : null;
    if (!match) return next();
    res.setHeader("Cache-Control", "no-store");
    const expiresAt = performance.now() + policy.deadlineMs;
    let done = false;
    let cancelRead: (() => void) | undefined;
    const finish = () => {
      done = true;
      clearTimeout(deadline);
      cancelRead?.();
      req.removeListener("aborted", disconnected);
      res.removeListener("close", disconnected);
      res.removeListener("finish", finished);
    };
    const disconnected = () => finish();
    const finished = () => {
      finish();
      // A rejected chunked upload may never end. Close after the response bytes
      // flush; neither parsing nor rejection waits for unbounded body drainage.
      if (res.statusCode >= 400) req.socket.destroySoon();
    };
    const reject = (status = 403) => {
      if (done || res.writableEnded || res.destroyed) return;
      const error = new McpLaunchBlockedError();
      done = true;
      cancelRead?.();
      req.pause();
      res.setHeader("Connection", "close");
      if (status === 429) res.setHeader("Retry-After", "60");
      res.status(status).json({ error: { code: error.code, message: error.message } });
    };
    const expire = () => {
      if (!res.writableFinished && !res.destroyed) {
        // Ended/queued is not transport completion. Even a rejected response
        // behind another pipelined response must release its socket by cutoff.
        reject();
        req.socket.destroy();
      }
      finish();
    };
    const inactive = () => {
      // The event loop can delay the timer callback past the deadline. Check
      // elapsed monotonic time before beginning proof or returning success.
      if (performance.now() >= expiresAt) expire();
      return done || res.writableEnded || res.destroyed;
    };
    const deadline = setTimeout(expire, policy.deadlineMs);
    deadline.unref();
    req.once("aborted", disconnected);
    res.once("close", disconnected);
    res.once("finish", finished);

    function body(): Promise<string> {
      return new Promise((resolve, rejectBody) => {
        const chunks: Buffer[] = [];
        let bytes = 0, settled = false;
        const settle = (failed: boolean) => {
          if (settled) return;
          settled = true;
          req.removeListener("data", data);
          req.removeListener("end", end);
          req.removeListener("error", error);
          cancelRead = undefined;
          if (failed) rejectBody(new McpLaunchBlockedError());
          else resolve(Buffer.concat(chunks, bytes).toString("utf8"));
        };
        const data = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > policy.bodyBytes) { settle(true); reject(); }
          else chunks.push(chunk);
        };
        const end = () => settle(false);
        const error = () => settle(true);
        cancelRead = error;
        req.on("data", data);
        req.once("end", end);
        req.once("error", error);
        if (req.readableEnded) end();
      });
    }

    try {
      hostnameGuard(req, res, () => {
        if (inactive()) return;
        const headerNames = req.rawHeaders.filter((_, index) => index % 2 === 0);
        const authorization = req.header("authorization") ?? "";
        const token = /^Bearer (pcmwe_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
        const contentType = req.header("content-type") ?? "";
        const length = req.header("content-length");
        if (!token || headerNames.filter(name => name.toLowerCase() === "authorization").length !== 1 ||
            req.url.includes("?") || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
            req.header("content-encoding") !== undefined ||
            (length !== undefined && (!/^\d+$/.test(length) || Number(length) > policy.bodyBytes))) return reject();
        // Express resolves req.ip using the operator's trust-proxy policy. Never
        // use raw forwarded headers or the enrollment UUID as a budget key.
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        if (!admit(ip)) return reject(429);
        void (async () => {
          try {
            const subject = { enrollmentId: match[1], bearerToken: token };
            await service.authenticateBootstrap(subject);
            if (inactive()) return;
            const proof = mcpWorkerEnrollmentProofSchema.parse(JSON.parse(await body()));
            if (inactive()) return;
            const receipt = await service.prove({ ...subject, ...proof });
            if (!inactive()) res.json(receipt);
          } catch { reject(); }
          finally {
            // An HTTP timeout/disconnect is not DB settlement. Keep the permit
            // while preauth/proof work is queued or running; never enqueue more.
            inFlight -= 1;
          }
        })();
      });
    } catch { reject(); }
  };
}
