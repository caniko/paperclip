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
does not import the Hermes adapter.

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
