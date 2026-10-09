# Hermes executor routing

`hermes_gateway` accepts an optional `executorEndpoints` array (or JSON array
string). It contains one to eight distinct URLs. Its first URL must match
`apiBaseUrl`. All endpoints use the deployment's existing `apiKey` secret binding.

```json
{
  "apiBaseUrl": "https://workers.example/execution/primary/operations",
  "executorEndpoints": [
    "https://workers.example/execution/primary/operations",
    "https://workers.example/execution/secondary/operations"
  ],
  "sessionKeyStrategy": "issue"
}
```

Remote URLs require HTTPS. Loopback HTTP remains supported. URL credentials,
queries and fragments are rejected. Probes send the gateway bearer credential
and refuse redirects. Authentication refusals are surfaced rather than hidden
by fallback. Keep credential-bearing inventories under normal agent/company
access controls; the inventory grants no new authority.

For a fresh conversation, the adapter probes `/v1/capabilities` in order. A
worker must advertise `runs_executor_admission` version 1 with `accepting: true`
and positive `available_slots` (or `null` for unlimited capacity), plus
`runs_recovery` version 1 with `durable_lineage_stop`, `admission_binding: 1`
and `ordinary_stop_admission`. Unreachable, draining, full or older workers
cannot accept pool selection. The worker still owns atomic admission and its
concurrency limit; the probe reserves nothing.

The controller stores issue- and agent-scoped executor affinity independently
of issue-local provider session results in `adapter_session_affinities`.
Agent scope spans issues; issue scope uses the same issue key as the provider
conversation. Timer wakes without an issue, run and none strategies select fresh.
The session codec also retains `executorBaseUrl` for older/direct callers.
Conversations stay on that endpoint even when another endpoint becomes available. An
unavailable pinned worker produces `hermes_gateway_executor_unavailable`. A
removed worker produces `hermes_gateway_executor_affinity_invalid`; reset the
session explicitly to select a new worker. Existing pre-pool conversations and
protected execution targets remain on the primary. Run and none strategies
start a new selection for each new run. Unambiguous historical sessions are
adopted on first use; conflicting worker history fails closed until explicit reset.

Pool execution requires the controller's durable execution checkpoint callback.
Before POST dispatch the controller commits the conversation pin in the same
transaction as the encrypted execution checkpoint. First-turn controller loss
therefore retains the worker even without a finalized task session. Explicit
session reset clears the pin and increments a durable generation; a preparing
old turn cannot restore it. Once it seals the selected endpoint, headers and exact wire body, uncertain
admission, lineage observation, Stop and recovery never select another worker.
Capability observations and mutable lineage progress remain separate from that
immutable checkpoint. A selection inventory does not authorize a collector,
protected-root mutation, filesystem enrollment or host activation.

For mobile workers, use Hermes `gateway.api_server.admission_file`. Publish an
operator-owned JSON file `{"version":1,"accepting":false}` to drain new run
admissions while keeping existing runs, idempotent replays and Stop reachable.
Read failures must close admission. Keep the worker's configuration, credentials
and units stable during the profile transition so it can settle admitted work.

Focused hosted checks cover executor selection, the session codec, cross-issue
controller continuity, reset fencing and uncertain admission/recovery.
Full application qualification remains required before
using a successor source in deployment.
