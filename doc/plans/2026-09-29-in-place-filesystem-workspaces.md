# In-place filesystem workspaces

Status: implementation in progress; deployment qualification pending.

## User outcome

A company can maintain an existing filesystem directory using a local worker or
an SSH-backed worker. The directory may be a user home, a data directory, or a
repository. Changes affect the existing directory and preserve the executing
user's ownership. Worker credentials, sessions, caches, and build state live in
separate directories.

This must work on ordinary Linux with OpenSSH. Host discovery, host names,
routing preferences, declarative operating-system configuration, and deployment
leases belong to the operator's integration.

## Existing contracts

- Environments identify an execution substrate. They are instance-level objects;
  workspace, agent, issue, and lease attribution remain company-scoped.
- A project workspace with `sourceType: non_git_path` identifies an existing
  directory. It does not require repository bootstrap or a Git worktree.
- `workspaceRealization.mode: in_place` identifies the authoritative directory.
  Copy-in, restore, and deletion of that directory are inappropriate.
- The core-resolved `executionTarget` is authoritative. Instructions, payload
  templates, and resumed session metadata cannot replace it.

## First implementation: a configured worker

Hermes already binds a served profile to a terminal backend and working directory.
Use that binding rather than accepting an SSH private key or an arbitrary backend
configuration in a run request. A separately configured worker/profile is an
initial deployment strategy, not a new Paperclip target registry.

Hermes advertises a versioned execution-context capability and accepts an optional
`execution_context` precondition on `/v1/runs`. It compares the requested backend,
working directory, and SSH host/port/user with the effective profile policy before
admission and pins that policy across construction and execution. A mismatch fails explicitly. The request
does not change the profile policy. A bound run must not be redirected to another
live conversation owner or autonomously retried without that precondition.

Paperclip's gateway adapter opts into this binding, derives the precondition from
the selected execution target/workspace, verifies protocol support before POST,
and scopes resumable sessions to the bound target. An older gateway must never
silently ignore a requested binding. Legacy unbound gateway configurations retain
their current behavior.

For SSH, Hermes needs a separate `terminal.ssh_hermes_home`: an absolute path on
the remote host used for worker state synchronization and `HERMES_HOME` in remote
commands. The login identity owns created data. This setting is not a filesystem
sandbox and does not change Unix permissions or the login home.

## Authorization and lifetime

An environment label is not a filesystem security boundary. Company access must
be enforced by Paperclip's existing admission/permission paths; worker credentials
must be bound to the intended company/profile by the deployment. Path comparison
does not provide containment. Use the operating system's service/SSH policy to
limit worker access.

Shared local/SSH workspaces retain existing concurrency semantics. The implemented
exclusive filesystem ownership mode is opt-in, understands overlapping and
symlinked roots across companies, and holds ownership until descendants stop.
Do not infer exclusivity from an issue checkout or an environment lease.

Run cancellation, shutdown, reconnect, and lost-acceptance recovery must preserve
the existing process-lifetime contract. Passing binding tests alone does not
qualify maintenance of real home directories.

### Implemented lifetime contract

In-place bindings request `execution_context.lifetime: wait_for_jobs` from Hermes;
other bound workspaces can opt in with `waitForJobs: true`. Capability negotiation
requires the advertised lifetime. Paperclip retries uncertain admission using the
identical idempotent request, keeps cancellation ownership through nonterminal
stop responses, and waits for terminal status before collecting stopped-provider
instructions. Child/tool completion events cannot settle the parent run. Resumed
metadata retains its target fingerprint through the adapter session codec.

Hermes has a transport-independent job supervisor contract and an initial systemd
user-manager provider for local and SSH execution. Target-side launch/stop fences,
durable run receipts, and cgroup lifetime cover detached descendants. Delegated
workers are tracked by their actual futures. Run-scoped `execute_code` kernels
retain variables between cells, close at normal completion, and stop on cancel.
Real local/OpenSSH tests cover active-cell cancellation, descendant lifetime,
lost admission acknowledgements, and API-process crash/recovery.

Paperclip now has company-bound encrypted recovery intent, immutable grants,
independent execution/ownership checkpoints and checkpoint-preserving lease writes.
Protected preparation rejects incompatible controller-side writers and bypasses
referenced/additional repository preparation, GitHub staging and runtime services.
Real local/OpenSSH Hermes fixtures exercise file writes, terminal HOME isolation
and two persistent kernel cells under two independent gateway profiles.

The host authority now uses authenticated peer UIDs, atomic multi-root grants,
conservative separate exclusion domains, bounded FIFO waiting, launch fences,
stop tombstones and explicit controller release. Completed jobs retain durable
settlement receipts so subsequent observations avoid repeated manager probes.
The system provider uses an empty-root namespace and verifies mounted inode
identities before workload admission. Its privileged qualification remains pending.

See [Existing filesystem workspaces](../filesystem-workspaces.md) for the stable
configuration and recovery contract.

## Contribution and qualification sequence

1. Hermes remote worker-home isolation: scoped YAML plumbing, synchronization,
   command environment, compatibility, A -> B -> A profile tests, OpenSSH fixture.
2. Hermes execution-context precondition: capability, validation, admission and
   execution checks, conversation/recovery rules, authenticated HTTP tests.
3. Paperclip binding consumer: target translation, capability check, session
   identity, protocol tests, accurately scoped environment support.
4. Deployment inventory: derive enabled host/users and effective home/data paths
   from the operator's existing topology and account declarations. Keep personal
   company declarations separate from system identity, confinement and workers.
5. Qualify disposable directories locally and through SSH: create and replace,
   owner UID/GID, symlink aliases, missing roots, stop with descendants, reconnect,
   and worker-state isolation. Then qualify real deployment configuration.

Each contribution is independently reviewable. No production filesystem access
is implied by enabling the protocol capability or by a passing mock test.

## Verification and qualification — 2026-09-30

Verified development evidence:

- Hermes authority, claims, job supervision, durable admission/recovery and
  two-gateway ownership: 35 passing tests across six files. The latest focused
  authority gate passes 13 tests, including missing launch/exit receipts and a
  lost stop acknowledgement. An exit code cannot settle a job whose stop failed.
- Paperclip Hermes adapter: 100 passing tests across 12 files (separate from the
  root Vitest selection).
- Ownership forms: 36 passing tests. Task wait, live-update cache, shared run
  surface and environment form gate: 222 passing tests across four files.
- Live-run deduplication, ownership handoff, pending/successful cancellation and
  visible cancellation failure, plus Cursor/GitHub fixture portability: 27 passing
  tests across five files. Local sandbox fixtures use the test host's effective
  tool PATH instead of assuming `/usr/bin` and `/bin` contain tools. The final
  live-run-only gate passes four tests without React act-environment diagnostics.
- Existing waiting Storybook capture: Chromium at 320, 768, 1024 and 1440 widths,
  without diagnostics or horizontal overflow. Additional surface qualification
  is in progress.
- Managed AI project-auth ancestor lookup, Railway SSH tool resolution, hiring and
  native-session portability: 137 passing tests across six files.
- Earlier full typecheck and build passed; final source-stable checks are required.
  The last full test attempt was intentionally stopped after reproducing four
  local fixture failures; those four now pass in the focused portability gate.
  This is not a passing full-suite receipt.

### Outstanding gates

1. **Disposable Atlas system-provider run.** An earlier passing disposable run
   predates the empty-root, same-UID credential/cross-worker read, requested
   subdirectory/sibling, and delayed ancestor replacement assertions. The harness
   declined the strengthened privileged invocation. An operator must run the
   current `tests/tools/test_filesystem_authority_system.py` through
   `scripts/run_tests.sh` with a root runner. Do not count its non-root skip as proof.
2. **Independent Paperclip controllers.** Target-client/two-gateway fixtures and
   company-bound checkpoint tests are evidence, but end-to-end exclusion through
   independently persisted Paperclip instances remains unqualified.
3. **Replacement and disaster recovery.** Qualify reboot, authority replacement,
   ledger I/O/corruption, older-ledger restore, enrollment/credential rotation and
   abandoned-owner recovery. A restored old ledger must not admit conflicting
   work while target jobs may survive. No automatic active-claim expiry is allowed.
4. **Writer/resource/control-cost qualification.** The protected Hermes path owns
   file/terminal operations, kernels and delegation; controller provisioners,
   instruction bundles and runtime services are refused. Qualify the deployed
   workload's toolchain, networking, CPU/memory/task limits and control traffic.
   Unprotected adapter staging is not evidence for the protected path.
5. **Canix maintenance rollout.** Active host candidates remain `atlas`, `nomad`,
   `starlord`, `murph`, `bar`, and `thething`; `camel` is inactive. Personal
   declarations remain in Home Manager; identity, confinement, workers and
   authority enrollment belong in NixOS. Qualify Atlas-local and Nomad-SSH access
   using disposable roots and selected-user UID/GID, then coordinate Atlas/Nomad
   synchronization writers before enrolling canonical repositories or homes.
   Existing worker confinement hides homes, `/data`, and `/run/user` and has not
   been qualified for this maintenance path. Both Paperclip instances stay disabled.

No deployment/activation or production filesystem enrollment has occurred. The
direnv/nix-direnv reload investigation is complete: the existing concurrent
`nix-provenance` update resolves evaluation with lock updates forbidden; preparation
preserved the Canix flake, lock and `.envrc` hashes. Do not run `nix flake check` for
this work.
