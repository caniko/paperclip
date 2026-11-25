# OpenCode local adapter

The adapter starts OpenCode in the selected execution workspace. It sets the
child process `PWD` to that workspace. Local and Atlas invocations select the
workspace without adding `--dir`, which OpenCode 2 does not accept. Other remote
targets use the realized workspace path. Explicit operator arguments remain unchanged.

This directory handling does not imply full OpenCode 2 protocol support.

Run the adapter checks from the repository root:

```sh
pnpm exec vitest run packages/adapters/opencode-local/src
pnpm --filter @paperclipai/adapter-opencode-local typecheck
```

## Runtime configuration

`prepareOpenCodeRuntimeConfig` stages an isolated OpenCode configuration directory
on the host for both local and remote execution targets. It copies the operator
configuration and applies the runtime provider and permission settings. Its
returned `XDG_CONFIG_HOME` points to that host directory.

For remote execution, `execute` and `testEnvironment` pass the staged directory
to `prepareAdapterExecutionTargetRuntime` as the `xdgConfig` asset. They replace
`XDG_CONFIG_HOME` with the asset's remote destination before running OpenCode.
The helper's cleanup function removes the host staging directory. The operator's
Git configuration is included only for local runs. Atlas uses worker-owned
configuration instead of a host-staged copy.
