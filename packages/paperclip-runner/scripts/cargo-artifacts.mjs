import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Tooling only: callers must run the matching locked Cargo build first. Metadata
// resolves Cargo's environment/config overrides; artifact presence is not freshness.
export function resolveCargoTargetDirectory({
  packageRoot = defaultPackageRoot,
  execFile = execFileSync,
} = {}) {
  const stdout = execFile("cargo", [
    "metadata",
    "--format-version=1",
    "--no-deps",
    "--manifest-path", "runner/Cargo.toml",
    "--locked",
    "--offline",
  ], {
    cwd: packageRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Cargo metadata returned invalid JSON", { cause: error });
  }
  const targetDirectory = metadata?.target_directory;
  if (typeof targetDirectory !== "string" || !isAbsolute(targetDirectory)) {
    throw new Error("Cargo metadata target_directory must be an absolute path");
  }
  return targetDirectory;
}

export function resolveCargoBinary({
  binary,
  profile = "debug",
  platform = process.platform,
  targetDirectory = resolveCargoTargetDirectory(),
}) {
  for (const [name, value] of Object.entries({ binary, profile })) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
      throw new Error(`Cargo ${name} must be a single artifact name`);
    }
  }
  if (typeof targetDirectory !== "string" || !isAbsolute(targetDirectory)) {
    throw new Error("Cargo target directory must be an absolute path");
  }
  const artifact = join(targetDirectory, profile, `${binary}${platform === "win32" ? ".exe" : ""}`);
  let file;
  try {
    file = statSync(artifact);
  } catch (error) {
    throw new Error(`Cargo artifact is missing: ${artifact}. Run the matching locked Cargo build first.`, { cause: error });
  }
  if (!file.isFile()) throw new Error(`Cargo artifact is not a file: ${artifact}`);
  return artifact;
}
