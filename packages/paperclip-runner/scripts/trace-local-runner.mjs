import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCargoBinary, resolveCargoTargetDirectory } from "./cargo-artifacts.mjs";

function binaryArgument(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return value;
}

export function traceLocalRunner({
  args = process.argv.slice(2),
  spawn = spawnSync,
  resolveTargetDirectory = resolveCargoTargetDirectory,
  resolveBinary = resolveCargoBinary,
} = {}) {
  const runner = binaryArgument(args, "--runner-binary");
  const harness = binaryArgument(args, "--fake-harness-binary");
  const forwarded = [...args];
  if (runner === undefined || harness === undefined) {
    const targetDirectory = resolveTargetDirectory();
    if (runner === undefined) forwarded.push("--runner-binary", resolveBinary({ binary: "paperclip-runnerd", targetDirectory }));
    if (harness === undefined) forwarded.push("--fake-harness-binary", resolveBinary({ binary: "fake-harness", targetDirectory }));
  }
  const result = spawn(process.execPath, [
    fileURLToPath(new URL("../dist/cli/local-runner.js", import.meta.url)),
    ...forwarded,
  ], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Local runner trace terminated by ${result.signal}`);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = traceLocalRunner();
}
