// pnpm 9's patch hashes differ from pnpm 10. Change only the sandbox copy;
// dependency versions and integrity entries remain owned by the upstream lock.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
let lock = readFileSync("pnpm-lock.yaml", "utf8");
const patches = [...lock.matchAll(/^    hash: ([a-z0-9]+)\n    path: (patches\/[^\n]+)$/gm)];
if (patches.length === 0) throw new Error("No pnpm patch hashes found");
for (const [, old, file] of patches) {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  lock = lock.replaceAll(old, hash);
}
writeFileSync("pnpm-lock.yaml", lock);
