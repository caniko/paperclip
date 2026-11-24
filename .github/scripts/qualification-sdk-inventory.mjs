import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./qualification-roster.mjs";

export function inventory(directory, base = directory, files = {}) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file, base, files);
    else if (entry.isFile()) files[path.relative(base, file).split(path.sep).join("/")] = sha256(readFileSync(file));
  }
  return files;
}
