/**
 * Builds `opencode run` argv for the OpenCode v2 CLI.
 *
 * v2 has no `--dir` (the workspace is the process cwd, and OpenCode trusts PWD
 * over it, so callers must set PWD) and no `--variant` (it is `--model
 * provider/model#variant`). Without `--standalone`, v2 runs tools in the shared
 * background service, which never sees this run's env or runtime config.
 */
export function buildOpenCodeRunArgs(input: {
  model: string;
  variant: string;
  extraArgs: string[];
  resumeSessionId?: string | null;
  printLogs?: boolean;
}): string[] {
  const args = ["run", "--format", "json"];
  if (input.printLogs) args.push("--print-logs");
  if (input.resumeSessionId) args.push("--session", input.resumeSessionId);
  // ponytail: a variant without a model is dropped; v2 cannot select one for its default model.
  if (input.model) {
    args.push("--model", input.variant && !input.model.includes("#") ? `${input.model}#${input.variant}` : input.model);
  }
  const optionTerminator = input.extraArgs.indexOf("--");
  const extraOptionArgs = optionTerminator === -1 ? input.extraArgs : input.extraArgs.slice(0, optionTerminator);
  if (!extraOptionArgs.some((arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="))) {
    args.push("--standalone");
  }
  args.push(...input.extraArgs);
  return args;
}
