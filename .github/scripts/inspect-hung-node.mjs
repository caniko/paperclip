#!/usr/bin/env node
// Profile a live Node process whose event loop may be starved. SIGUSR1 opens
// the inspector on its own thread, so this works even when timers never fire.
const [pid, port = "9229"] = process.argv.slice(2);
if (!/^\d+$/.test(pid ?? "")) throw new Error("Pass the target process ID");
setTimeout(() => { console.error("Inspector capture timed out"); process.exit(2); }, 90_000).unref();
process.kill(Number(pid), "SIGUSR1");
let targets;
for (let attempt = 0; !targets?.length && attempt < 50; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => undefined);
}
if (!targets?.length) throw new Error(`No inspector target on port ${port} for ${pid}`);
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
let id = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
  socket.send(JSON.stringify({ id, method, params }));
});
const where = frame => `${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`;
await call("Profiler.enable");
await call("Profiler.setSamplingInterval", { interval: 500 });
await call("Profiler.start");
await new Promise(resolve => setTimeout(resolve, 3_000));
const { profile } = await call("Profiler.stop");
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
const count = keys => [...keys.reduce((counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
console.log(`CPU profile of pid ${pid}: ${profile.samples.length} samples over 3 s; self time:`);
for (const [key, samples] of count(profile.samples.map(sample => where(nodes.get(sample).callFrame))).slice(0, 25)) console.log(`  ${samples}\t${key}`);
for (const [leaf, samples] of count(profile.samples).slice(0, 5)) {
  console.log(`\nhot stack (${samples} samples):`);
  for (let node = leaf; node !== undefined; node = parents.get(node)) console.log(`  at ${where(nodes.get(node).callFrame)}`);
}
socket.close();
process.exit(0);
