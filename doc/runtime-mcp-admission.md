# Runtime MCP admission boundary

The reusable contract and implementation live in
[`caniko/harbor-llm`](https://github.com/caniko/harbor-llm), exported as
`harbor-llm/mcp-admission`. Paperclip's controller and adapters consume that
implementation through the compatibility re-export
`@paperclipai/adapter-utils/mcp-admission`; Paperclip carries no second evaluator.
The MCP module has no external runtime imports, performs no I/O, stores no grants
or credentials, and accepts no agent configuration. It checks a **trusted operator
decision** against core-resolved servers and returns immutable, run-bound delivery
metadata. Paperclip retains authorization, policy resolution and gateway issuance.

## Contract

The version-1 policy contains exact connection IDs, MCP URLs, credential-recipient
URLs, server-host identities, and allowed execution-host identities. A maximum
of eight servers can be delivered per invocation. The helper rejects duplicates,
unknown policy fields, inherited authorization fields and host-array entries,
invalid identities, mismatched endpoints, unapproved hosts, and unsafe recipients. HTTPS and explicitly approved
loopback HTTP are supported. Credentials, queries and fragments are forbidden in
recipient URLs. Failure uses `runtime_mcp_admission_blocked` with a content-free
`reason`; errors contain neither endpoint details nor token values.

`bindMcpServersToRun` preserves the input display name, extra caller fields and
the **exact approved recipient string**. It overwrites any previous binding with
a newly validated, frozen binding. `requireMcpRunBinding` checks the binding
again at a consumer boundary. These helpers do not authenticate a JSON document;
only the controller's trusted call path may supply admission policy.

The JSON Schema exports and conformance vectors describe this versioned metadata
contract for other languages. Harbor owns the runtime schema exports and their
canonical JSON assets under `harbor-llm/contracts/`:
`mcp-admission-policy.v1.schema.json`, `mcp-run-binding.v1.schema.json`, and
`mcp-admission-conformance.v1.json`. Paperclip's conformance tests import these
upstream assets directly.
URL security and authorization relationships are
semantic checks in addition to schema validation. A schema-valid JSON document
alone is never authority to connect or deliver a token.

Hermes owns its dashboard `/chat` → `/api` aliases, wire serialization,
connection-ID-based tool namespace, capability negotiation and
`hermes_gateway_managed_mcp_blocked` error translation. Its adapter validates the
raw approved and configured recipients before trimming or normalization and compares the normalized result
with its dispatch destination before making a network request. Core admission
binding helper does not import the Hermes adapter.

Adapters that require this delivery precondition declare
`requiresRuntimeMcpRunBinding: true` on their `ServerAdapterModule`. Core selects
admission through this capability rather than an adapter type name. The Hermes
gateway adapter declares it; adapters using their existing delivery paths keep
their existing contract.

## Enforcement owners

| Requirement | Enforcement owner |
| --- | --- |
| Company, project, agent, task, run, connection and operation grants | Paperclip `tool-access.ts`, `tool-gateway.ts`, gateway routes and core assignment resolution; rechecked at the destination |
| Exact recipient and selected execution/server identities | Generic binding helper; Hermes verifies the recipient before network dispatch; worker verifies its own operator endpoint/host policy |
| Cross-host use | Explicit execution identity in controller policy and worker policy; mismatched identities never imply authorization |
| Reader versus producer credentials and immutable evidence view | Trusted Chaosbox connector and Chaosbox reader; producer/ingestion credentials are never worker MCP credentials |
| Token expiry, revocation and run subject | Paperclip's existing run-scoped gateway tokens and destination authorization; the generic binding is metadata, not a bearer credential |
| Replay and run/attempt ownership | Core's durable execution checkpoint and Hermes idempotent admission; a binding cannot be moved to a different run |
| Conversation isolation and profile/config overrides | Hermes adapter and worker admission; managed invocations start fresh and cannot override the managed manifest |
| Shell, direct requests and alternate filesystem/network paths | Worker execution boundary and destination authorization; a TypeScript helper cannot confine an agent's operating-system identity |
| Catalog/request/result budgets, cancellation and settled client cleanup | Worker-owned private MCP client and Chaosbox reader; caller-wait cancellation does not prove operation settlement |
| Recovery | Core retains the encrypted checkpoint and original destination; Hermes reconciles original owned admission instead of starting replacement work |
| Pinned versus observed build and host identity, source exclusions, provenance | Trusted host connector and Chaosbox evidence policy; a capability host label alone is not proof of host identity |
| Filesystem ownership, one host per directory, local/SSH, Wait for jobs | Existing workspace ownership and execution-context contracts, independently of MCP admission |

The current `executionHostId` supplied by Paperclip is the selected environment's
identity. An operator must bind it to the actual worker/execution host in both
policies. The helper does not discover a physical host from a URL or turn an
environment ID into attested host identity.

## Reuse and qualification

The reusable implementation is a library subpath of Harbor LLM's source package.
The adapter-utils dependency declaration pins Harbor commit
[`c9cbd2803e5cd69c1945bbf10ddf2efb9648fed7`](https://github.com/caniko/harbor-llm/commit/c9cbd2803e5cd69c1945bbf10ddf2efb9648fed7);
installation needs no build or prepare script. Compatibility exports retain the
same function and error-class identities rather than wrapping or copying them.
Paperclip's dependency lockfile follows its existing CI-owned lock policy.
Qualification of an unpublished pin using the same local Git object is local
source evidence; remote installability additionally requires that commit to be
available at the declared GitHub origin.

Harbor's tests cover the generic helpers, exported assets, an independent MCP
service and packed-module imports without harness dependencies. Paperclip tests
cover compatibility identities, its controller policy translation, and Hermes
dispatch. There is no separate lifecycle runtime or grants database.
A runtime extraction requires two concrete consumers in the same role. Sharing a
contract between a TypeScript controller and a Python worker does not demonstrate
that role equivalence.

Conformance checks cover exact matching, cross-host denial, unsafe-recipient
denial, duplicate and inherited decisions, fresh run bindings and provider-owned
normalization. A separate loopback MCP fixture demonstrates service neutrality.
These checks qualify the metadata helper and adapter path. Deployment acceptance
still requires the actual trusted connector, worker artifacts, destination grant
checks, bypass isolation, recovery reauthorization, bounded operations and
verified settlement, as well as the combined consumer gates.

## Durable prepared launches (controller foundation)

`server/src/services/mcp-prepared-launch.ts` implements a private, company-scoped
controller ledger in `mcp_prepared_launches`. This is the foundation for fresh
worker authorization; it currently has no producer HTTP route or heartbeat
dispatch integration. The deployed Hermes managed capability stays gated on its
existing qualification boundary.

A preparation seals the complete effective outbound JSON **and headers**, including
credentials and the original admission key. Its snapshot binds company, agent,
issue, project, run, controller instance/boot and dispatch generation; enrolled
Ed25519 worker/key identity, approved recipient and execution host; separately
authorized MCP server hosts/endpoints and credential references; assignment and
policy digests **and revisions**; and finite expiry. Launch JSON is limited to
1 MiB, headers to 32 KiB/32 distinct names, and the complete serialized envelope
to 2 MiB before encryption. Harbor validates identifiers, credential endpoints
and host-binding relationships.

The public launch digest is an HMAC using a random per-launch salt retained only
inside the encrypted envelope. It covers the ledger ID and copied, validated
snapshot, including the exact outbound body bytes. It does not expose a reusable
credential hash. Encrypted material is bound back to the stored company/run/task/
project/generation/expiry and launch ID during every read.

### Challenge and retry lifecycle

1. `prepare` serializes on the task and run, then persists at most one immutable
   preparation per run. Matching retries return its original ID and digest.
2. `challenge` resolves current authority and persists a random, 60-second nonce.
   Concurrent retries see the same challenge. An expired, unconsumed challenge
   can be renewed atomically while the preparation is still live and unchanged;
   earlier proofs cannot authorize its replacement nonce.
3. `authorize` verifies the enrolled worker's Ed25519 signature over the ordered
   protocol array produced by `mcpLaunchProofBytes`. It consumes the challenge
   once. Lost-ack retries recheck current authority and return the same durable
   receipt, including after challenge expiry, until launch expiry.
4. `claimDispatch` requires the existing sealed pending adapter checkpoint. Host
   code validates its company/run/lease binding through
   `readPendingAdapterExecutionCheckpoint`; the Hermes producer validates that
   its recipient, complete headers, body and admission key recover **this exact
   launch**. Only one concurrent claim succeeds. Later retries return `false`;
   they do not confer another dispatch entitlement.

The trusted controller resolver is mandatory for each operation. It receives only
stored scope, reconstructs the complete effective launch and authenticated worker
enrollment, checks current company/task/operation/host/connection permissions,
and locks mutable authority rows through commit. A normal missing/changed result
permanently revokes the preparation, including actual task/run-row changes.
Restoring earlier policy bytes does not revive it. A resolver exception denies
without consuming the challenge, allowing a transient outage to recover.
Assignment/policy revisions must identify their authoritative mutations, so an
unobserved change-and-restore cannot hide behind an identical content digest.

All ledger mutations and content-free activity events commit together. The
database wall clock and current controller lease are checked across asynchronous
boundaries and before commit. SQL lock waits are bounded at 5 seconds and
statements at 15 seconds. Resolver reads must also be bounded; external worker or
connector I/O belongs outside the locked transaction. Public failures use fixed
`runtime_mcp_admission_blocked` text and expose no endpoints, prompts, keys or
credentials.

### Recovery and retirement

An accepted worker proof establishes key possession, not a physical-host
attestation or filesystem/network confinement. The controller must dispatch the
stored bytes and preserve the producer's original recoverable admission rather
than rebuilding it from agent-supplied labels. A changed controller boot,
generation or authority cannot reuse the preparation to start replacement work.
Existing Stop, cancellation and ownership settlement use their original private
checkpoints independently of fresh producer admission.

Expiry or revocation retains the ledger and all recovery ownership. Restrictive
company/run/task/project references deliberately prevent deleting referenced
entities before reconciliation. `retireForDeletion` is an explicit controller
operation: it requires a terminal run and settled company leases, including orphan
teardown rows with no run pointer. Release timestamps are insufficient: pending
cleanup, failures/in-flight cleanup, retained or still-reusable resources, and
pending/malformed adapter **or filesystem** evidence block retirement. Settled
checkpoints retain a valid producer fingerprint; filesystem evidence must reference
its terminal, same-company/run workspace-finalization operation. The bounded SQL
scan admits at most 1,024 leases and returns only IDs and validity flags, not
encrypted checkpoints or provider metadata. A historical Stop receipt survives
handoff: it is discharged only by later, scoped destruction of the same allocation
under the same company/environment/provider/plugin and workspace or task-agent
scope. An active, pending-cleanup or foreign-scope successor never discharges it.
Retirement atomically records retirement and removes the sealed ledger.
Entity-deletion integration must use this operation before deleting a
populated ledger's owners. It is not an expiry-driven cleanup or authority transfer.

MCP enrollment and launch writers acquire company `KEY SHARE` before their child
locks; retirement starts with the company `UPDATE` deletion barrier. Proof's
unlocked identifier lookup only discovers company scope, which is reread under
the parent lock before authenticating the locked enrollment. Transactional lease
handoff/reacquisition takes the same parent barrier before its predecessor mutation
and successor insertion. Task-before-run ordering remains in place.

The focused suites cover real PostgreSQL concurrent retries, changed task rows,
challenge renewal/replay, usable producer recovery, actual lock contention,
elapsed-time expiry through resolution/checkpoint decryption, audit rollback for
every mutation, and ownership-aware retirement. Full runtime acceptance still
needs authenticated enrollment and its transactional resolver, the token-verified
run-authorization route, exact stored-launch dispatch, trusted Chaosbox scoped
views and private transport, and the combined consumer qualification.

## Operator-pinned worker enrollment (controller foundation)

`mcp_worker_enrollments` and `server/src/services/mcp-worker-enrollment.ts`
provide the private enrollment ledger. The exact bootstrap-authenticated proof
POST described below is wired into the application; HTTP provisioning remains
unavailable and managed admission remains disabled. A trusted controller supplies
the instance identity; an operator supplies company-scoped worker/key labels,
canonical Ed25519 SPKI public key, exact approved recipient, separately named
execution host, and an enrollment lifetime of at most 720 elapsed hours. Agent profiles and
launch payloads cannot supply enrollment authority.

Preparation issues a random 256-bit `pcmwe_` bootstrap bearer, returned only in
the one-time preparation response and hashed in the ledger, plus a random nonce.
The bootstrap authorizes only enrollment proof, for at most five minutes and
never beyond enrollment expiry. The worker signs the ordered
`paperclip.mcp-worker-enrollment-proof.v1` array produced by
`mcpWorkerEnrollmentProofBytes`: it binds the enrollment/company/controller,
all approved pins including the public key, nonce, and both deadlines. Retries
with the authenticated bootstrap and original proof return the same receipt and
revision within that deadline. Ordinary inspection excludes verifier and nonce.

Row locks serialize proof and revocation; database wall-clock checks run again
after audit writes. Every state transition rotates an opaque revision and commits
with a content-free activity event. SQL guards permit only `pending → enrolled`,
`pending → revoked`, and `enrolled → revoked`. They prevent pin replacement,
reactivation, direct insertion of accepted rows, and deletion of key-label
tombstones. An expired or revoked key never releases adapter or filesystem
ownership. A replacement requires explicit revocation and a fresh key label.

`readEnrolledMcpWorker` is for the trusted launch resolver's existing transaction.
It locks the enrolled row through commit, checks company/controller identity and
state, and requires `launch.expiresAt <= enrollment.expiresAt`. This propagated
deadline lets the prepared-launch foundation's final clock checks cover key
expiry during later asynchronous work. Key possession does not attest a physical
host or establish filesystem/network confinement.

### Bootstrap proof ingress

Only `POST /mcp/worker-enrollments/:uuid/proof` uses bootstrap authentication before
the global body parser, raw-body capture, HTTP logger and ordinary actor
authentication. It retains the existing hostname gate and trusted-proxy policy.
The bootstrap must appear once in `Authorization: Bearer pcmwe_…`; query
credentials, duplicate authorization headers, compressed bodies and non-JSON
media types are rejected before database access. The JSON body accepts only a
canonical Ed25519 `signature`, never controller, company, host or other authority
pins. Header authentication permits receiving this bounded proof; the mutation
rechecks the bootstrap, current row and deadline under its lock.

The ingress caps a body at 1 KiB and the complete request/response transport at
30 seconds. Oversized or stalled chunked uploads do not trigger unbounded drainage.
Normal rejection may flush its fixed response; the hard deadline also closes a
backpressured socket even when a response is ended or queued. Monotonic elapsed
time is checked before proof and success, independently of timer scheduling.
Each application process retains at most 1,024 client budget keys, allows 30
attempts per client per 60 seconds, and holds at most eight non-queueing database
work permits. Client addresses come from Express's operator-configured trust
policy, not raw forwarded headers. Full client capacity fails closed rather than
evicting a live budget. A timeout or disconnect retains its permit until outstanding
database work actually settles. These are process-local bounds, not a distributed
quota. Failed proof responses contain fixed, content-free admission guidance;
proof payloads and credentials never enter the ordinary HTTP logger.

The trusted controller identity is captured once at application construction.
An instance label unsupported by the narrower MCP contract blocks proof ingress,
while ordinary application startup retains its existing instance-label contract.
Pins are never silently truncated or remapped. An enrollment receipt is an
inspection result, not fresh runtime launch authority; runtime authorization
must still recheck the current enrollment and grants.

Provision/inspection/revocation endpoints must enforce instance-admin **and**
company authorization before they are exposed. Browser sessions and implicit
local-board access cannot replace bootstrap proof. Audited company retirement
preserving key-label tombstones must be qualified before production provisioning
is exposed. The grant resolver, runtime ingress/dispatch, protected worker-side
key handling and combined transport acceptance remain required.

### Permanent company retirement (qualification pending)

Migration `0298_high_vulture.sql` atomically replaces the enrollment/company FK
with live-company insertion guards and permanent retirement records. Original
enrollment pins, labels and final revisions survive company and activity-log
deletion. Immutable typed receipt entries preserve each launch's company,
agent, task, run, project, controller boot and generation; they retain no sealed
launch material. Deferred SQL checks require the complete receipt and company
deletion to commit together. Direct deletion, rekeying, truncation and reuse of
a retired company UUID are guarded.

Launch insertion takes the company barrier and is fenced after the retirement
header exists. Launch identity and scope are immutable. After that header exists,
launch deletion requires its exact matching receipt, including nullable issue and
project IDs, controller boot and generation. Pre-header launch disposal retains
its settlement checks. Launch-table TRUNCATE is blocked.

Company UUID insertion and deletion require PostgreSQL READ COMMITTED isolation.
The AFTER INSERT guard runs after uniqueness contention; stronger snapshot
isolation is rejected rather than trusting a snapshot taken before retirement.
The company removal service selects READ COMMITTED explicitly. Retired UUIDs
are permanent identity barriers, not reusable company labels.

`mcp-company-retirement.ts` runs inside the existing company removal transaction,
before purge, with the company UPDATE barrier already held. A company with MCP
state must be archived and have current instance-admin and company authority.
Local sessions/API keys recheck locked role and active-membership rows. Cloud
actors use the authentication-owned stack-owner role and the canonical managed
owner-elevation setting under a row lock; persisted instance roles cannot elevate
a Cloud actor. Trusted implicit local-board authority retains its existing
operator semantics. Companies without MCP state retain ordinary board deletion.
Their environment leases must still satisfy the company-wide settlement
predicate, including orphan `pending_cleanup` leases. This check does not impose
the MCP archive, controller identity, instance-admin, or PostgreSQL-17 requirements.
Both deletion paths retain every runtime row while runtime settlement is
unqualified.

Access mutations acquire the company barrier before membership/grant locks.
Exact-set access updates and production human-membership writers share a per-user
transaction advisory lock, before company barriers and child locks. This includes
member status/archive operations, Cloud synchronization, board claims, startup
local-board seeding and deployment reconciliation. Multi-company operations lock
parents in sorted ID order. Membership-ID writers revalidate the company and
principal identity after locking. A complete scope reread rejects newly discovered
companies with a refresh-and-retry conflict.

The user fence requires actual READ COMMITTED isolation, including nested
transactions: a repeatable-read snapshot acquired before a wait could hide the
preceding producer from both discovery and reread. Default grant seeds use the
current locked active membership and role; delayed seeds cannot restore grants
after access removal. Permission activation and publication, copied membership
defaults, Cloud defaults and board-claim defaults retain the same transaction
fence through publication. Explicit replacement rejects archived memberships.

Deployment bootstrap fences its exact existing or reserved fresh actor ID before
blocking role ownership. Reconciliation retains that identity through apply and
rejects an account appearing under a different ID after preflight. Both public
and managed-loopback authentication instances preserve the reserved ID generator.

Retirement admits at most 1,024 enrollments, launches and leases per collection,
with a 1 MiB serialized receipt ceiling. Lease inspection returns IDs and SQL
validity flags rather than encrypted checkpoints or provider payloads. PostgreSQL
17 or later is required: retirement disarms any inherited transaction timer and
rearms a 30-second budget less all elapsed work since BEGIN. Lock waits remain
limited to five seconds and statements to fifteen seconds. PostgreSQL disables
the transaction timer before durable commit/WAL completion; the budget does not
claim to bound that final durable-commit interval.

**Native-backed company retirement remains blocked.** Native cleanup currently
publishes SQL `settled` before completing runtime-owner release and filesystem
activation-marker removal. A committed coordinator, expired lease or historical
settlement therefore cannot authorize deleting recovery references. The native
owner needs durable final-settlement evidence, company-first claim fencing and
qualified dependent-record purge before this gate can be widened. Retirement
performs no native cleanup or ownership transfer.

**Runtime-backed company deletion also remains blocked.** A `stopped` status,
`stoppedAt`, removed exposure, or missing in-memory registry entry does not prove
that a backend or provisioning continuation has settled. Every
`workspace_runtime_services` row therefore preserves its company recovery scope,
including legacy and adapter-managed rows.

Runtime entry points commit a starting recovery row under company-first parent
locks before provisioning, adoption, broker reservation, or process spawn.
Starting intent does not reserve a configured port; the allocator publishes the
port it actually selects. Manual starts and retries perform resource work after
those short transactions commit. Returned private broker handles are persisted
before hostname resolution or backend binding, and failure bookkeeping updates
status/timestamps without replaying stale ownership fields. Healthy shared reuse
validates its declared owning scope and retains its original workspace pins; an
unhealthy runtime leased by another run keeps a distinct owner and replacement ID.
Registry IDs are adoption hints, not replacement IDs. Rejected adoption preserves
the original recovery row and gives provisioning, reservation and replacement
spawn their own committed intents. Actual adoption revalidates the returned ID
and its owning pins before health checks, termination or publication; legacy
missing-row restoration retains the original resource identity. These barriers
protect empty-runtime-set deletion. They do not supply
generation fencing, cancellation drainage, verified termination of unregistered
backends, or process/provision/exposure settlement receipts; those are required
before accepting or purging runtime recovery rows.

### Disposable qualification fixtures

Company fixtures use scoped, transactional child-first deletion in
`server/src/__tests__/helpers/company-fixtures.ts`. Company-wide TRUNCATE reaches
the permanent retirement/key guards even when their tables are empty. The fixture
helper retains those guards and refuses to reset a selected company with MCP
state; ledger/retirement tests must instead own a fresh disposable database.
Paired runner attempts retain deterministic company/user IDs and a stable
controller instance identity while removing the previous attempt's company data.

Before resetting or disposing a fixture, stop new scheduling and await existing
HTTP, heartbeat, plugin, export, browser and transfer work. Orderly application
shutdown drains started startup/sweep callbacks, plugin lifecycle handlers,
watcher lookups/restarts/closure, and scheduled/manual jobs after stopping new
work. A heartbeat quiescence deadline
or an embedded PostgreSQL shutdown deadline is an explicit test failure. Database
files are reclaimed only after successful PostgreSQL exit; a stop rejection retains
them. Tests that insert synthetic run rows without starting executors close only
those known synthetic rows before checking real dispatched work for quiescence.
Retry and authorization fixtures explicitly pause dispatch for their disposable
companies and use the owning heartbeat cancellation workflow before teardown.
Cancellation refusal retains the database; the passive quiescence helper does
not cancel work or accept exhausted polling as settlement.
Synthetic closure is fixture isolation, not runtime/native ownership settlement.
