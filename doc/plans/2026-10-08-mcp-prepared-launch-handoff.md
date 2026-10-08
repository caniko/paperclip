# MCP prepared-launch handoff — 2026-10-08

The controller retirement and ownership prerequisites are saved and source-qualified.
Production managed MCP admission remains disabled. Resume with protected enrollment
administration before implementing current-grant runtime authorization.

## Checkout and publication

- Repository: `caniko/paperclip`.
- Branch and publication target: `feat/mcp-prepared-launch-20261007` on `origin`.
- Base savepoint: `f7472ac4b6799da7b7f777e8ba4af7a71ae01e56`.
- Session: `ses_f10b00eb7ffe591y6Qp8ER7M0r`.
- Model: `openai/gpt-6.1-sol`.

Origin and upstream references were fetched. Sync publishes this qualified feature
branch, establishes its upstream tracking, and verifies exact local/remote equality.
The upstream master observed during fetch was
`0ac194450a48a407450921a16c3ef8684dcb85ca`; integrating its newer history requires
separate qualification. Preserve protected owner checkouts and unpublished bytes.

The signed implementation/test commits are:

| Commit | Change |
| --- | --- |
| `d17a711f98f34088e543c2fd86c8bf3ae3471204` | Fence company access and bootstrap publication |
| `9b3f36caf9a13158b6757bcc541cad75c161a328` | Retain exact MCP company retirement receipts |
| `7ae5d4c03b87db5cebe6e589b0ff22383d853e5b` | Retain runtime ownership before resource work |
| `59bf1678634c81312f04765149388a89e2a60a00` | Drain application and fixture work before disposal |
| `f6e9b9ea0fc8ad4cc8cddd1c33a427455b6d1de9` | Compare archived project membership without ordering |
| `22ca145c7488b5cdf23511c6181982c70491164c` | Settle composer picker timers before teardown |

The seventh commit, `docs: record MCP prerequisite qualification and handoff`,
contains this resumption record, the runtime-boundary documentation, and changelogs.
Commit signing uses OpenPGP key
`818D507F1E62139F8A17EAA64623DEA06FDACFE1`. Managed identity/signing hooks remain
active. Publication preflight passed after fetching the fork's advanced
`fix/hermes-lineage-hosted-qualification-20261007` tip, supplying already-published
ancestry to the push hook.

## Saved implementation

1. User membership/grant writers share a READ COMMITTED per-user fence, then
   sorted company parents and child locks. Default grants derive from locked
   active membership; activation and publication commit together. Bootstrap and
   reconciliation reserve the exact actor ID, including managed-loopback auth.
2. Migration `0298_high_vulture.sql` adds permanent retirement receipts,
   enrollment tombstones, exact launch-deletion receipts, immutable identity,
   retired UUID reuse protection, and TRUNCATE guards. Original `0297` is
   preserved. The generated `0298` snapshot replaces the obsolete `0293` snapshot
   under the existing snapshot-pruning policy.
3. Company removal locks its parent before authorization and children, rechecks
   current instance-admin/company authority, and records retirement atomically.
   Cloud elevation requires authenticated stack-owner provenance and the locked
   canonical owner-elevation setting. Orphan cleanup and every runtime recovery
   row prevent deletion until their owning workflows establish settlement.
4. Runtime starts persist recovery intent before provisioning, adoption,
   reservation, or spawn. Resource work runs outside short SQL transactions.
   Returned private handles survive partial failure. Actual registry adoption
   revalidates the returned identity and ownership; replacements retain distinct
   IDs and preserve rejected-adoption evidence.
5. Application shutdown stops new work and drains started background callbacks,
   plugin handlers/jobs/watchers, chat reconciliation, and Vite closure. Fixtures
   use scoped child-first deletion and refuse protected MCP state. HTTP aborts,
   heartbeat drain exhaustion, and PostgreSQL shutdown failures stay explicit
   failures with recovery data retained. Owning cancellation targets only exact
   disposable company scopes. Synthetic run closure targets recorded test IDs.
6. Composer picker tests own their QueryClient, React `act` scope, fake timeout
   clock, deferred Radix focus restoration, and zero-pending-timer assertion.
   Cloud session mocks model the new locked transaction shapes. Archived-project
   tests retain exact membership/duplicate assertions without assuming SQL order.

## Qualification evidence

Evidence root on the qualified host:
`/data/scratch/tmp/opencode/generic-mcp-contract-20261006/`.
Each check receipt records command, time, exit, source identity, and log SHA-256.
The approved provider fingerprint is
`924fc95fd5d2151a5143141362042809484a9bc7921ea7829171df54fa93843d`.

The source gates cover **30,622 passing tests and 67 existing skips** across the
three general groups, 151 serialized suites, and five additional adapter projects.
Focused prerequisite reruns are additional evidence and are excluded from that
total. Workspace typecheck, the affected UI/server typechecks, token gates, and
the workspace build pass.

Qualification spans mapped runs. Review8 tested source identity
`668f19f5a54a301700f925bbaeaab295ea31ab544d347ac08d5f7899242b4925`.
Only three test files changed afterward:

- `ui/src/components/task-chat/ComposerRunSettingsPicker.test.tsx`;
- `server/src/__tests__/auth-session-route.test.ts`;
- `server/src/__tests__/projects-list-archived-routes.test.ts`.

The final qualified source identity, before these handoff/changelog additions, is
`a3607a7d0730c0e37506341f1a64ce54847e8845e4b8a4abe9da14e32f3a37d5`.
Production source remains byte-identical to Review8; each changed test has passing
focused or containing-suite evidence. `mcp-handoff-qualification-final-20261008.json`
records hashes and the permitted test-only differences for each run.
`mcp-handoff-qualified-baseline-final-20261008.json` records the final file hashes;
publication readback must match them, allowing only this document and the two
changelog additions.

| Gate | Receipt stem | Result |
| --- | --- | --- |
| Workspace typecheck | `mcp-retirement-review8-approved-typecheck1-20261008` | Passed |
| Prerequisite/affected-consumer suites | `mcp-retirement-review8-combined-approved1-20261008` | 1,710 passed / 68 files |
| General server | `mcp-retirement-review8-general-server-approved1-20261008` | 15,455 passed / 772 files; 54 tests / 4 files skipped |
| Focused picker suites | `mcp-picker-settlement-green-approved1-20261008` | 11 passed / 2 files |
| General workspaces A, including runner tests | `mcp-picker-workspaces-a-green-approved1-20261008` | 7,894 passed / 746 files |
| UI typecheck | `mcp-picker-typecheck-approved2-20261008` | Passed |
| Token gates | `mcp-picker-token-gates-approved1-20261008` | Passed |
| Signed Git fixture suites | `mcp-handoff-git-fixtures-posix-approved3-20261008` | 98 passed / 2 files |
| General workspaces B | `mcp-handoff-general-workspaces-b-posix-approved3-20261008` | 4,186 passed / 312 files; 13 tests / 2 files skipped |
| Cloud session projection | `mcp-handoff-auth-session-green-approved4-20261008` | 12 passed |
| Final server typecheck | `mcp-handoff-server-typecheck-posix-approved5-20261008` | Passed |
| Serialized prefix | `mcp-handoff-serialized-posix-approved4-20261008` | 133 suites passed before the repaired archived-project test |
| Serialized remainder | `mcp-handoff-serialized-remaining-posix-approved5-20261008` | 18 suites passed; all 151 covered, 2,874 tests passed |
| Additional adapter projects | `mcp-handoff-omitted-projects-posix-approved7-20261008` | 213 passed / 28 files |
| Build | `mcp-handoff-build-posix-approved7-20261008` | Passed |

`mcp-handoff-serialized-coverage-approved5-20261008.json` verifies the exact current
151-suite roster, the prior 133-suite prefix, its log hash, and unchanged source
apart from the one repaired archived-project test. The remaining 18 suites use
the stable runner's per-suite process and compact fixture-directory isolation.
This is coverage across two runs, not a claim that the interrupted full command
exited successfully.

The combined JSON report confirms actual successful execution of all 68 selected
suites, including real PostgreSQL retirement (55 assertions), current operator
authorization (10), prepared launches (64), enrollment (27), migration upgrade
(2), membership writer contention (5), and application/plugin settlement.
The report SHA-256 is
`33869317a86d2ce426d27d1abaf5bf211313479d6645e8b4c0719dbc6db5ab9b`.

### Resolved qualification interruptions

- The original UI gate passed assertions but exited 1 for an unhandled
  Radix/JSDOM event-realm error. RED repair found a pending timeout in each of
  five open-popover tests; the repaired group exits 0 without unhandled errors.
- The first tail attempt timed out waiting for the shared evaluation lease.
  The second omitted the qualified Git template and failed five managed-Git
  commits, plus one signed-fixture timeout. Restoring the historical POSIX shell,
  immutable template, and bounded workers passed all 98 affected tests and
  workspace B with hooks active.
- The third attempt stopped at Cloud session mocks lacking transactions,
  isolation reads, and locked row shapes. The repaired mocks pass all 12 tests,
  including existing access-denial and stale-admin-removal assertions.
- The fourth stopped because an unordered archived-project SQL query returned
  both exact expected IDs in the opposite order. The assertion now sorts both
  exact ID arrays, retaining inclusion, exclusion, and duplicate checks.
- Two later adapter attempts never started because a live neighboring Canix
  evaluation held the lease. A thirty-minute lease wait then allowed both build
  and adapter gates to pass through the approved provider.

Checks run serially under systemd with `MemoryMax=16G`, `MemorySwapMax=4G`,
`CPUQuota=400%`, `CARGO_BUILD_JOBS=2`, and
`NODE_OPTIONS=--max-old-space-size=4096`. The final driver is
`qualify-handoff-final-gates7-20261008.mjs`. Its approved wait wrapper waits for,
then releases, the shared evaluation lease before Canix reacquires it normally.
Give every receipt a unique name. Preserve the recorded `SHELL`,
`GIT_TEMPLATE_DIR`, `VITEST_MAX_WORKERS=2`, `GOMAXPROCS=2`, and workspace
concurrency one. Browser/release suites and paid-provider/live transport evals
were outside this prerequisite scope. `nix flake check` was excluded by request.

## Resume order

1. Implement enrollment provisioning, inspection, and revocation with the company
   barrier, then `assertMcpOperatorInTx`, then child access. Require authenticated
   user actors, controller-scoped reads, revoke reauthorization, content-free
   finite errors, pre-parser `no-store`, closed logging projections, and shared
   lazy initialization. Proposed routes are POST
   `/api/companies/:companyId/mcp/worker-enrollments` (201), GET
   `/api/companies/:companyId/mcp/worker-enrollments/:enrollmentId` (200), and POST
   to that enrollment's `/revoke` with exactly `{}` (200). Keep malformed-parser
   payloads and arbitrary credential copies out of logs. Carry `cloudStackRole`
   from authentication explicitly; `getActorInfo(req)` omits it. Map
   `McpLaunchBlockedError` to a finite refusal instead of generic 500 handling.
   Never acquire a user fence after the company barrier. Current `prepare`/`revoke`
   only validate user-shaped identity; `inspect` lacks actor authorization and
   controller filtering. Preserve bootstrap proof ingress.
2. Qualify current membership/role/Cloud-setting contention, audit rollback,
   cross-controller isolation, parser privacy, and unsupported-instance startup.
3. Complete runtime generation fencing, Stop during readiness/provision/exposure,
   unregistered-backend termination, ambiguous broker recovery, and durable
   settlement receipts. Native SQL `settled` currently precedes runtime-owner
   release and activation-marker removal; native retirement stays blocked.
   Preserve evidence from the earlier interrupted `CONNECTION_CLOSED` recovery
   run; later passes do not explain that interruption.
4. Qualify Harbor packaging and exact dependency pins, then align Hermes manifest
   `gateway_url`, token host/recipient/digest binding, separate execution/server
   host identities, and private transport settlement. The 24 GiB memory/swap
   start gate and installed-distribution Nix paths remain unestablished.
5. Implement trusted `resolveCurrent(tx, scope)`, token-verified
   `POST /mcp/gateways/:gatewayPublicId/run-authorization`, sealed single-winner
   dispatch, heartbeat integration, and HTTP-to-immutable-Chaosbox-reader views.
6. Complete deployed-worker bypass/host/cancellation/recovery/credential acceptance
   and hosted owner semantic reconciliation before enablement. The previous
   hosted comparison matched 14 of 46 owner paths; revalidate current pins.

## Cross-repository state and ownership

Paperclip consumes published Harbor
`c9cbd2803e5cd69c1945bbf10ddf2efb9648fed7`.
The following local branches retain prerequisite work:

| Consumer | Branch | Observed HEAD | State |
| --- | --- | --- | --- |
| Harbor | `feat/mcp-python-consumer-20261006` | `e947aef908a7ab017f622fa4dfce855213b43975` | Local; untracked `node_modules` retained |
| Hermes | `feat/generic-mcp-consumer-20261006` | `a7f01970be453a69dd34d1716421d1e49eb5d09d` | Local; clean |
| Chaosbox | `feat/paperclip-reader` | `7805454b5fe2943f99b10ffd8df3d5a6d4b1bc61` | Local; later dirty owner work retained |

Harbor publication authorization remains limited to
`feat/mcp-admission-20261006`; the newer local Python branch needs a later
publication decision. Hermes publication has not been requested.

Harbor owns provider-neutral contracts and conformance. Paperclip owns current
authorization, assignments, approvals, credentials, and auditing. Hermes owns
wire negotiation, worker integration, finite error translation, and private
transport. Chaosbox owns evidence semantics/provenance and immutable reader views;
Jev remains producer-only. Generic bindings do not authenticate grants, attest
physical hosts, or confine shell/network access. Lifecycle extraction still needs
two concrete consumers in the same role.

Default execution to the worker's host; require explicit cross-host authorization
and actionable blocked-capability results. Preserve source exclusions, budgets,
Jev consent, independent filesystem ownership, one host per directory, local/SSH
execution, Wait for jobs, and systemd-first supervision. Stop, cancellation, and
reconciliation remain available independently of fresh producer authorization.
Preserve owner checkouts, focused branches, unique commits, and unpublished bytes.

Protected owner baseline identity:
`c182dc5531342f6fa44ab17de8d7918b414c455514c071bf001bea5189c63ffe`.
Original `0297_equal_sally_floyd.sql` SHA-256:
`0b300e5595a579b577da497f35b54cabd2a61a42d690298952b28a2e00b0b5ea`.

Retain scratch receipts and recovery data. The publication verifier is
`verify-mcp-handoff-publication-20261008.mjs`; it checks signed commits, clean
status, advertised remote HEAD, zero divergence, qualified Git-object bytes,
original `0297`, and protected-owner preservation. Its receipt is
`mcp-handoff-publication-verification-20261008.json`.
The committed handoff is the portable resumption record. Supporting local logs
remain on the qualified host. No bound Paperclip heartbeat/API task context was
available for artifact upload; repository publication supplies the deliverable.
