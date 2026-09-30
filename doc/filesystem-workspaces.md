# Existing filesystem workspaces

Status: opt-in implementation; production host qualification is pending.

Paperclip can select an existing directory as a `non_git_path` project workspace
and realize it `in_place`. The directory remains the authoritative copy. It must
already exist; preparation does not create a replacement, copy files back, or
delete it at completion. A repository can use this mode when its canonical
checkout, rather than a task worktree, is the intended work product.

## Owning host and execution identity

Use **one host per directory**. Run a local Hermes worker on its owning computer,
or configure a fixed SSH worker for that computer. Multi-host writable mounts are
outside this contract. `local` names the worker's backend, not the computer hosting
the Paperclip controller.

The served Hermes profile's backend, exact working directory and SSH host/port/user
must match the selected execution target. Paperclip negotiates version-1
`execution_context` support before starting work. In-place targets also require
`wait_for_jobs`; unsupported workers and target mismatches fail explicitly.
Worker keys remain in worker configuration. Resumed conversations are scoped to
the target and cannot redirect it through templates or session metadata.

Files are created as the enrolled execution user. The authority's control user
is separate from that user. Infrastructure configuration owns these identities,
socket access, the authority service, and confinement. Personal company and
directory declarations do not grant operating-system authority.

## Opt-in exclusive ownership

The local/SSH environment editor exposes **exclusive filesystem ownership**.
Its API configuration is:

```json
{
  "workspaceRealizationMode": "in_place",
  "filesystemOwnership": {
    "authority": "target-authority-id",
    "principal": "enrolled-controller-principal",
    "roots": ["/srv/maintained/project"]
  }
}
```

SSH environments additionally need their normal host, username and
`remoteWorkspacePath` settings. Ownership currently requires `hermes_gateway`
and a worker enrolled with the same authority and principal. Disabling ownership
restores ordinary local/SSH concurrency; in-place realization alone is not a lock.
Environment config PATCHes merge keys: omitting either policy field preserves its
saved value. Clear ownership with `"filesystemOwnership": null`; the server removes
that field from the stored/read config. Disable in-place realization with
`"workspaceRealizationMode": "copy"` and clear ownership in the same PATCH if it was
enabled, because ownership requires `in_place`. The editor sends these explicit
values when the toggles are disabled and clears ownership when realization is
disabled. Other config keys are preserved.

One host-local Hermes authority arbitrates all enrolled controllers using its own
protected, durable ledger. Controller databases and their leases are not shared
locks. Requests acquire the complete root set atomically. Overlapping ancestors,
descendants and symlink aliases conflict, including an original inode moved out
of its domain or a replacement placed at a reserved pathname. Older conflicting
waiters cannot be overtaken; unrelated ownership domains can run concurrently.

Enrollment roots also define conservative exclusion domains. Those domains may
serialize siblings that share writable metadata or hardlinks. They do not expand
the writable grant: only the requested directories and private claim runtime
are bound into the workload namespace.

## Preparation, execution and cleanup

Paperclip persists company/run/lease-bound encrypted recovery intent **before**
asking for ownership. It records the returned grant immutably before protected
workspace preparation. A lost acknowledgement retains the original request for
reconciliation, rather than acquiring under a new identity.

Protected preparation rejects controller-side provision/cleanup commands, Git
worktrees, managed runtime services, and adapters that write instruction bundles
outside the target supervisor. It bypasses additional/referenced repository
materialization, GitHub launcher staging and local scratch creation. Hermes file
and terminal operations, persistent code kernels and delegation share the grant's
supervised lifetime. Their temporary files, HOME, caches, data and build outputs
live in the claim runtime, outside maintained roots.

The system provider starts from an authority-owned empty `RootDirectory`, adds
platform tools read-only, and mounts the exact requested canonical and alias
directories. It verifies mounted inode identities before loading workload code
or environment. The initial provider limits tasks and memory and denies workload
networking. Qualify the deployment's actual toolchain and required operations
against those limits before enrolling real directories.

Cancellation fences new launches and stops existing jobs and descendants before
acknowledging settlement. Normal completion drains descendants and tool teardown.
Paperclip then finalizes the workspace and releases instruction copies before an
explicit authority release. An exit status alone is not settlement. No active
claim expires because a controller, gateway or SSH connection disappears.

## Waiting and recovery

The task, issue thread, live-run panel and run detail expose the durable waiting
state, even after volatile progress expires: **No agent work has started**. Stop
remains available during the wait. Handoff removes the notice; failed cancellation
keeps ownership visible and reports the failure.

Restart seals previous grants before exposing the ledger for new admission. Stop
before admission persists a tombstone, and uncertain launches use immutable job
IDs without replaying user commands. Authority refusal is an explicit `409` with
`code: "rejected"`; Paperclip retains recovery intent until stop/release confirms
settlement. Missing ledger files, unavailable supervisors and revoked control
credentials must not be treated as free directories.

Keep the target authority ledger, controller database and encryption key in their
respective recovery plans. Restoring an older authority ledger while target jobs
may survive is not qualified. Do not replace that ledger with a controller backup
or initialize a fresh ledger to clear ownership. Recover control access and obtain
target-side fencing and settlement evidence first.

Other writers, such as synchronization services, also need coordination with the
same exclusion domain before rollout. Application tests and user-systemd fixtures
prove protocol and lifecycle behavior; they do not prove system-provider namespace
isolation or real-host maintenance readiness. Current evidence and remaining
qualification gates are tracked in
[the implementation plan](plans/2026-09-29-in-place-filesystem-workspaces.md).
