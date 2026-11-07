---
title: T3 Code
summary: T3 Code local adapter setup and configuration
---

The `t3code_local` adapter runs Paperclip agents as threads on your local [T3 Code](https://github.com/pingdotgg/t3code) server. Each run is one turn: the first run starts a thread with `t3 thread start`, and later runs in the same working directory queue their message on that thread with `t3 thread send`. You can follow and steer the work in T3 Code's web, desktop, or mobile app, and T3 Code chooses the coding agent (Claude, Codex, OpenCode, and others) that runs it.

## Prerequisites

- T3 Code nightly `0.1.8-nightly.20261107.4327` or later (the tested official revision is `e455200077ce60806a01c8f28435b58860dcfc74`), with the `t3` CLI on the Paperclip server's `PATH` (or set `command` to its absolute path)
- A T3 Code server running as the same OS user as Paperclip: `t3 serve`, or `systemctl --user start t3code` when it runs as a user service. On the same machine the `t3` CLI signs in to that server as its owner; start, send, and list need no token. The adapter issues its own short-lived session only for the native stop RPC.
- Paperclip and the T3 Code server on the same host. The adapter runs on local execution targets only.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Fallback working directory (absolute path). The run's workspace is passed to T3 Code as the project path. |
| `provider` | string | No | T3 Code provider instance id, such as `claudeAgent` or `codex`. Set together with `model`. |
| `model` | string | No | Model slug for that provider instance. Set together with `provider`; leave both empty to use the project's default model. A project the adapter adds has no default model, so set both unless the project already has one in T3 Code. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to every message |
| `command` | string | No | CLI command override. Defaults to `t3`. |
| `env` | object | No | Environment variables for the `t3` CLI process, such as `T3CODE_HOME` for a non-default T3 Code data directory. They do not reach the agent. |
| `timeoutSec` | number | No | Run timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill, also the time allowed for T3 Code to confirm a stopped turn |

## How a run works

1. The message is built from the instructions file, the wake context, and the prompt template, then written to `t3` on stdin.
2. A new thread is started with `t3 thread start <cwd> - --title "Paperclip: <agent> (<run>)" --wait --json`. When no T3 Code project contains the working directory, the adapter runs `t3 project add <cwd>` once and retries.
3. A resumed run uses `t3 thread send <threadId> - --wait --json`. T3 Code queues the message as the thread's next turn; it never interrupts a running turn.
4. The final JSON line (`threadId`, `runId`, `status`, `reply`, `error`) decides the result. Exit code 0 is a completed turn and `reply` becomes the run summary. Exit code 1 is a failed or stopped turn. Exit code 2 means the agent asked a question that must be answered in T3 Code; the run fails with error code `t3code_needs_input` and names the thread.

## Session persistence

The adapter stores `{ threadId, cwd, provider, model }` (`provider` and `model` only when they are set). The next run resumes the thread only when the stored `cwd` matches the run's working directory and the stored `provider` and `model` match the agent's current ones; otherwise it starts a new thread, because a T3 Code thread keeps the model it started with. A session saved without `provider` and `model` counts as the project default, so it resumes only while the agent leaves both unset. When T3 Code no longer knows the stored thread, the adapter starts a new thread in the same run.

## Stopping

The adapter registers for cancellation before any setup. A Stop that arrives before a turn starts, including while the adapter adds the project or before it retries with a new thread, ends the run as `cancelled` without starting a turn.

On timeout or cancellation of a running turn, the adapter stops the thread through T3 Code's native orchestration RPC (`orchestration.dispatchCommand` with `thread.stop`) before it returns, then polls `orchestration.getThreadProjection` until the thread has no active run, provider turn, or subagent. Only then does Paperclip treat the provider as stopped; a confirmed Stop ends the run as `cancelled`. The adapter issues a short-lived local bearer session with `t3 auth session issue` as the same OS user, sends it only in the RPC upgrade header, and revokes it after the stop attempt. The confirmation, including every `thread list` call and the RPC stop, must finish within `max(graceSec, 5)` seconds. When the stop cannot be confirmed in that window, the run fails with error code `t3code_stop_unverified`. A run whose thread id was never printed is found again by its title with `t3 thread list --json`.

Paperclip's crash recovery does not treat the `t3` process as the provider: if Paperclip restarts or loses the process, the run is not retried or continued automatically. It is held for reconciliation, as for gateway adapters, because the turn may still be running in T3 Code.

## Limits

- Stopping uses T3 Code's official orchestration RPC (`thread.stop`), not a fork-only CLI command. Any stop RPC failure, including an unsupported method or an error naming a missing thread, produces `t3code_stop_unverified` with an error naming the thread; the adapter does not infer a stop from error text, so the turn may still be running in T3 Code.
- The agent runs inside T3 Code's provider process, so it does not receive Paperclip's `PAPERCLIP_*` environment variables, the run JWT, or Paperclip-managed skills. T3 Code's providers use their own skills and credentials.
- T3 Code does not report token usage or cost; runs are recorded as unpriced.
- Model choice comes from T3 Code. Paperclip lists no models for this adapter.

## Environment Test

The environment test checks that `t3 --version` runs, that the CLI supports `t3 auth session issue` for the native stop, and that `t3 thread list --json` reaches a running server. When the server cannot be reached, the hint says how to start it; an older CLI without the session command is reported as unsupported.
