# Native Nix integration contract

## Scope and source

This integration packages Paperclip as a native application. It does not invoke
Docker, install dependencies on service startup, or require a downstream
configuration language. The supported package platform is **x86_64-linux**.

The application baseline is `7f3c06dac4604dddcf870085f1a623c102261358`.
The packaging started with [PR #10883](https://github.com/paperclipai/paperclip/pull/10883),
revision `3d8ee3e626c896f6884ab584fd8849c9a965897c`, imported with attribution in
commit `5d24c911e0870b5d4dda8cd0c6f2d5a2d87211b7`. Changes after that import adapt
the build to the current native Rust runner and add multi-instance services and
application provisioning.

## Exported interfaces

### Personal declarations and system infrastructure

`programs.paperclip.deployments.<name>` is a nonsecret native deployment
manifest. Home Manager renders it under
`$XDG_CONFIG_HOME/paperclip/deployments/<name>.json` without applying it or
starting a controller. This works in standalone Home Manager as well as the
NixOS integration. The CLI connection and personal credential-file reference
remain in `programs.paperclip`.

Import the optional `nixosModules.home-manager` alongside Home Manager's NixOS
module and Paperclip's NixOS module to select a declaration:

```nix
services.paperclip.homeManager.deployments.work = {
  user = "operator";
  deployment = "work";
};
```

The bridge imports the user module and supplies that declaration as
`services.paperclip.instances.work.manifest`. It does not enable the instance.
Each instance has one selected declaration and one reconciler. Different users
can use the same declaration key for separate controllers. Missing selections
and host extensions/overrides of selected manifests fail evaluation. Preserve
the manifest's `owner` and resource keys when moving an existing declaration
between files; changing its owner requires an explicit application handoff.

Unix accounts, database access, worker permissions, service lifecycle and
server credentials stay in NixOS. A Home Manager declaration is trusted
operator configuration, not an application authorization boundary: its owner
key does not grant membership and its workspace paths do not grant filesystem
access. Personal client secrets never need to become controller credentials.
See `nix/examples/personal-declaration.nix` for the composition.

### Outputs

| Flake output | Contract |
| --- | --- |
| `packages.x86_64-linux.paperclip` / `default` | Immutable native application, UI, CLI, adapters and runner |
| `apps.x86_64-linux.default` | `paperclip` CLI |
| `apps.x86_64-linux.paperclip-server` | Conventional imperative server entry point |
| `nixosModules.default` / `paperclip` | Legacy singleton plus `services.paperclip.instances.<name>` |
| `homeManagerModules.default` / `paperclip` | Linux user services and client-only `programs.paperclip` |
| `nixosModules.home-manager` | Optional explicit selection of Home Manager declarations for system controllers |
| `lib.configuration` | Shared option definitions, configuration rendering and assertions; takes `{ lib, pkgs }` |
| `overlays.default` / `paperclip` | Adds `pkgs.paperclip` |
| `checks.x86_64-linux.package` | Builds the actual package |
| `checks.x86_64-linux.native-runtime-tools` | Exercises packaged OpenSSH key generation and listener ownership via `lsof` |
| `checks.x86_64-linux.module-evaluation` | System/user module evaluation and invalid-configuration assertions |
| `checks.x86_64-linux.nixos-module` | Original singleton VM check |
| `checks.x86_64-linux.declarative-instances` | Concurrent system embedded/external PostgreSQL and real Home Manager services |
| `checks.x86_64-linux.split-network` | Separate NixOS controller/worker VM staging check with a fake Hermes gateway and scoped API-key callback |

The native deployment executable is:

```text
paperclip-deployment /absolute/deployment.json [serve|plan|apply|check]
```

The default command is `serve`. The service modules generate its versioned JSON
descriptor and application configuration in the Nix store. Only **paths**, never
credential contents, belong in those files. The conventional `paperclip-server`
entry point retains its existing imperative configuration behavior; managed
services use `paperclip-deployment`.

## Service options

Both system and user instances share:

- `enable`, `package`, `stateDir`, `host`, `port`, `extraPackages`, `executionProfile`;
- `publicExposure`, `allowedHostnames`, `auth.enable`, `auth.publicBaseUrl`,
  `auth.secretFile`;
- `database.mode`, `database.embeddedPort`, `database.embeddedUser`,
  `database.embeddedDatabase`, `database.embeddedPasswordFile`,
  `database.dataDir`, `database.urlFile`, `database.migrationUrlFile`;
- `encryptionKeyFile`, `telemetry`, `manifest`, `credentialFiles`, `bootstrap`,
  and `settings`.

System instances additionally support `user`, `openFirewall`, `memoryMax`,
`tasksMax`, `inaccessiblePaths`, and `database.local.enable`. The latter provisions
a local PostgreSQL database with a runtime DML role and a separate migration/owner role. Connections
use peer authentication over `/run/postgresql`; the module writes their runtime
connection files and orders the service after database setup. It does not create
passwords in the store. Both roles are accessible to that instance's service UID
because the process performs startup migrations and plugin migrations.

`settings` is checked against the upstream configuration schema at launch;
unknown fields fail. It cannot override module-owned fields or embed
`llm.apiKey` or `database.connectionString` in the Nix store. Supply database
credentials through `database.urlFile` instead. Environment
configuration overrides and `.env` files are ignored in declarative mode.
Authentication defaults on, network binding defaults to loopback, and first-party
telemetry defaults off. Public exposure must be declared even when a public
reverse proxy forwards to loopback. It requires authentication, an explicit
canonical URL and external PostgreSQL.

Instance names are lowercase identifiers of at most 31 characters. Enabled
instances must have distinct listener/database ports, non-overlapping state
roots, and separate signing/encryption/embedded-database credential files.
System services also require distinct Unix users. User services share their
user's filesystem authority; multiple Home Manager services are not an OS
security boundary against one another.

The defaults are:

| Resource | NixOS | Home Manager |
| --- | --- | --- |
| Unit | `paperclip-<name>.service` | `paperclip-<name>.service` in user manager |
| User | `paperclip-<name>` | Home Manager user |
| State root | `/var/lib/paperclip-<name>` | `$XDG_STATE_HOME/paperclip/<name>` |
| Instance state | `<stateDir>/instances/<name>` | Same relative layout |
| Embedded DB | `<instance-state>/db` | Same relative layout |
| Bindings | `<instance-state>/deployment-bindings.json` | Same relative layout |

Choose ports explicitly when enabling multiple instances. User services require
a running user manager; configure lingering when they must survive logout.
Activation/restart behavior follows the systemd and Home Manager activation
policy chosen by the operator.

## Split-control-plane qualification boundary

**A functioning remote-only control plane is not ready in this revision.**
`executionProfile = "remote-only"` is a deployment-owned, fail-closed reservation:
the native launcher rejects `serve`, `plan`, `apply`, and `check` before importing
the server/adapter registry, reading credentials, or making application database
changes. It reports `remote-only execution is not yet qualified`. It does not
start a reduced-function server or fall back to local execution. This is a
qualification gate, not a completed runtime policy implementation.

`executionProfile = "trusted-local"` is the compatibility default for existing
descriptors and both module systems. It permits the existing execution paths;
select it only when controller-local code has the controller's trust. The profile
is independent of `auth.enable`: human authentication does not isolate execution.

The source audit found these blockers to safely opening the remote-only gate:

| Path | Finding and required enforcement |
| --- | --- |
| `server/src/services/execution-allowlist.ts` | Existing Kubernetes/managed-sandbox guards restrict environment drivers, not every controller-side action. |
| `server/src/adapters/registry.ts` | External adapters load at module initialization, can replace built-ins, and unknown `getServerAdapter` types fall back to `process`. A safe profile must prevent loading/installation and fallback before effects, not classify names. |
| `server/src/services/heartbeat.ts` | Shared run preparation resolves workspaces, Git identity and runtime tools before gateway invocation; the existing driver guard occurs after workspace resolution. Persisted configuration and per-run merged overrides require early enforcement. |
| `server/src/services/workspace-runtime.ts`, `execution-workspaces.ts`, `tool-gateway.ts` | Preview/build/provisioning commands and local stdio tools can execute under controller authority independently of the selected adapter. |
| `server/src/app.ts`, `services/plugin-loader.ts`, `routes/adapters.ts`, `routes/board-chat.ts` | Startup plugin loading, package installation, and the local board-chat relay need policy gates of their own. |
| `packages/adapters/hermes/src/gateway/server/execute.ts` | The executor uses HTTP/SSE and stable idempotency/session headers. It registers for the run's cancellation signal and verifies a terminal gateway status after `/stop` for a known run ID. Graceful restart cancellation and expired-lease crash classification have separate staging VM evidence below; ambiguous create responses, unresponsive gateways and automated remote-work recovery remain unqualified. |

The same NixOS module works on a host or a NixOS VM. A production controller VM
is optional; acceptance and staging use isolated VMs. No VM lifecycle framework,
scheduler, or alternate worker protocol is introduced.

### Evaluated controller and client examples

`nix/examples/split-controller.nix` is the intended staging contract: a dedicated
system identity, NixOS-managed PostgreSQL, private loopback listener, authentication,
telemetry off, runtime signing/encryption/worker credential references, and the
existing `hermes_gateway` adapter. **It intentionally cannot start while the
remote-only gate remains closed.** Import it alongside `nixosModules.default`;
the downstream operator supplies private HTTPS routing and runtime files.

`nix/examples/split-client.nix` imports with `homeManagerModules.default` and
configures only the CLI against that controller. Module evaluation checks both
examples and verifies that the client creates no Paperclip server instance.

`nix/examples/external-postgres.nix` uses the same controller contract with
operator-managed PostgreSQL and distinct runtime/migration URL files. Module
evaluation checks that it selects `postgres` and disables local database
provisioning. The downstream database owner supplies TLS trust, role grants,
network policy and backups; the example does not create or alter that external
database. Its remote-only profile is subject to the same closed qualification
gate.

The Hermes worker must be provisioned separately using its supported API server:

- `adapterConfig.apiBaseUrl` addresses that worker's HTTP API. In real deployments
  use private HTTPS; the adapter's development-only insecure-HTTP override is not
  a private-network guarantee.
- `credentials.apiKey` supplies the worker's Hermes `API_SERVER_KEY`. It is not a
  Paperclip API key. The controller uses `/v1/runs`, run status/events and `/stop`;
  results and session IDs use the existing adapter contract.
- `adapterConfig.paperclipApiUrl` supplies the callback address only. The gateway
  executor does not forward `ctx.authToken` as a worker Paperclip credential.
  Provision a separate scoped native Paperclip credential on the worker; use a
  declared task bridge for its supported project/assignee-limited task ingress.
  That task-bridge key is not a general result/session-management credential.
- The worker receives no controller signing/encryption files, database role,
  deployment descriptor credentials, sudo, or privileged socket access. Coding
  agents/builds need separately confined worker execution environments. A
  same-UID child is not isolated by an environment-variable filter.

The separate-node `split-network` check proves controller-to-worker gateway
dispatch, a worker-to-controller scoped read with cross-company denial,
revocation of the worker's Paperclip API key, idle controller restart with
persistent identities, and a live cancellation acknowledged only after the
worker's `/stop`. The nixpkgs VM fixture additionally passed graceful restart
with an in-flight run (one verified stop), a SIGKILL recovery after deliberately
expiring the crashed owner's lease (no speculative redispatch; the operator
stops the still-running worker), and a stopped-controller PostgreSQL dump/restore
with the original service credentials. It verified the operator session,
bindings, run history, secret-backed gateway dispatch and revoked callback key
after restore. The worker VM lacks the controller's signing path and local
PostgreSQL socket. These checks run under **trusted-local** with a test-only HTTP
gateway: they do not prove remote-only confinement, ambiguous-create recovery,
or restoration on a fresh controller with separately recovered credentials and
storage.

### Confidentiality outside the service state

`ProtectSystem=strict` makes host files read-only; it does not hide their contents
or prevent connecting to a Unix socket. NixOS instances additionally hide known
Docker, containerd, Podman, libvirt, and Nix daemon socket locations when those
locations exist at namespace creation. `ProtectHome` hides home directories.

Downstream deployments must list other private workspace/mount roots, including
paths outside `/home`, in `inaccessiblePaths`, for example:

```nix
services.paperclip.instances.control.inaccessiblePaths = [
  "/srv/operator-workspaces"
  "/data/private"
  "/run/custom-container-engine"
];
```

These explicit paths must exist before service startup; a missing path fails
namespace setup. Prefer hiding a stable parent directory for sockets created
later. Optional default socket paths absent at startup are not a promise to hide
future endpoints; inventory custom paths and aliases, order their provisioning
before the service, and restart the service when that inventory changes. Do not
hide the service's required credential or PostgreSQL socket directories.

The native VM check verifies that a world-readable `/srv` workspace is readable
by the service UID outside the namespace but unreadable inside it. It also checks
connection denial to a world-connectable fake container-engine socket from the
actual service mount namespace. This is filesystem/socket confinement evidence,
not certification of the blocked remote-only execution policy.

## Credentials and client-only configuration

Credential options are absolute **string paths**, not Nix path literals or
`builtins.readFile` expressions. Use a runtime secret manager or provision
protected files independently. Files must be regular, nonempty, outside the
store and unreadable by other users; use mode `0600` or an appropriately scoped
group. Multiline worker credentials are read literally, never evaluated by a
shell. Signing secrets require at least 32 characters; new embedded database
passwords require at least 16. Do not rotate an embedded password file without
changing the corresponding database role password.
`auth.secretFile` is required even in local-trusted mode: scoped worker tokens
still need a persistent signing key when human authentication is disabled.

Credential purposes are separate:

| Purpose | Source | Consumer |
| --- | --- | --- |
| Server signing | `auth.secretFile` | Better Auth and scoped runtime token signing |
| Runtime DB | `database.urlFile` | Application database pool |
| Migration DB | `database.migrationUrlFile` | Startup and plugin migration pool |
| Embedded DB | `database.embeddedPasswordFile` | Embedded cluster initialization and connections |
| Encryption | `encryptionKeyFile` or generated persistent master key | Native encrypted secret store |
| Worker | `credentialFiles.<key>` referenced by an agent | Native secret reference resolved for that worker |
| Task bridge | `credentialFiles.<key>` referenced by a bridge | Scoped native API-key record |
| CLI | `programs.paperclip.apiKeyFile` | CLI HTTP client only |
| Initial operator | `bootstrap.passwordFile` | Process-local account creation only |

Server signing and database credentials are held in process memory, not exported
into the server environment. Local-adapter inherited environments are
allowlisted in declarative mode; explicit worker bindings are added by the native
adapter path. Database utility passwords use a child-only `PGPASSWORD`, not a
command argument. A local adapter running as the service UID can still access
that UID's files: environment filtering does not sandbox untrusted local code.

Worker values use Paperclip's native encrypted secret store. Private database
bookkeeping includes SHA-256 fingerprints, consistent with the existing secret
version store; these fingerprints are not password-hardening and should be
treated as sensitive backup data. Plans export neither values nor fingerprints.

Every reconciliation verifies the configured encryption key against existing
local encrypted material, including historical and unmanaged versions. A missing
or incorrect key fails before application writes or dispatch, even on a no-op
apply. This verification does not generate a key or record secret-access
database timestamps. On a fresh database, omitting `encryptionKeyFile` retains native
first-write generation in persistent state; back up that generated key.

Client-only Home Manager configuration creates no service:

```nix
{
  imports = [ inputs.paperclip.homeManagerModules.default ];
  programs.paperclip = {
    enable = true;
    apiUrl = "https://paperclip.example.invalid";
    apiKeyFile = "/run/user/1000/secrets/paperclip-cli";
    # companyId may be populated from the exported company binding.
  };
}
```

The CLI also accepts `PAPERCLIP_API_KEY_FILE` directly. An explicit CLI token
argument takes precedence; otherwise the protected file takes precedence over
ambient token variables. An unreadable or invalid file fails rather than
silently falling back to another identity. Its contents are not exported to
subprocesses.

## Native declaration format

`packages/shared/src/deployment-manifest.ts` is the executable v1 contract.
Resource identities are **owner + kind + key**, never display names. Companies,
projects, agents, routines and routine schedules support explicit
`adopt = "<existing UUID>"` (for schedules, set `routines.<key>.schedule.adopt`).
Ambiguous name matches, cross-company references, reporting cycles, conflicting
owners, and adoption of plugin/bundled managed resources fail.

```nix
services.paperclip.instances.operations = {
  enable = true;
  port = 3101;
  database.local.enable = true; # NixOS only
  auth.secretFile = "/run/secrets/paperclip-operations-auth";
  auth.publicBaseUrl = "http://localhost:3101";
  bootstrap = {
    email = "operator@example.invalid";
    name = "Operator";
    passwordFile = "/run/secrets/paperclip-operations-bootstrap";
  };
  credentialFiles.gateway = "/run/secrets/paperclip-operations-gateway";
  manifest = {
    version = 1;
    owner = "operations";
    companies.example.fields = { name = "Example"; budgetMonthlyCents = 10000; };
    projects.main = { company = "example"; fields.name = "Main"; };
    agents.worker = {
      company = "example";
      fields = {
        name = "Worker";
        adapterType = "hermes_gateway";
        adapterConfig.apiBaseUrl = "https://gateway.example.invalid";
        budgetMonthlyCents = 2000;
      };
      credentials.apiKey = "gateway";
    };
    routines.daily = {
      company = "example"; project = "main"; agent = "worker";
      fields.title = "Daily work";
      schedule = { kind = "schedule"; cronExpression = "0 12 * * *"; timezone = "UTC"; };
    };
  };
};
```

This illustrates the interface; replace the example endpoint and provide runtime
credentials before enabling it. `nix/tests/module-evaluation.nix` and
`nix/tests/declarative-instances.nix` contain executable configurations for both
module systems, including concurrent instances.

Project fields accept the native `executionWorkspacePolicy` alongside `name` and
`description`. For example, a canonical shared checkout can declare:

```nix
manifest.projects.main.fields.executionWorkspacePolicy = {
  enabled = true;
  defaultMode = "shared_workspace";
  sharedWorkspaceConcurrency = "serialize";
  allowIssueOverride = false;
  workspaceStrategy.type = "project_primary";
};
```

Policy updates preserve the project identity. Set the field explicitly to `null`
to clear it. Explicit `serialize` defers dispatch behind a live shared-workspace
holder for local and SSH targets as well as sandboxes. `auto` retains concurrent
local/SSH dispatch. This controller gate uses the existing holder staleness and
retry rules; filesystem mutation ownership across controller disconnects still
requires worker-side execution-lifetime locks. Non-null database IDs in
`defaultProjectWorkspaceId` and `environmentId` are rejected in declarations;
this contract selects the project's primary workspace.

Named workspaces use `manifest.projectWorkspaces.<key>`, referencing a declared
project key and inheriting its company:

```nix
manifest.projectWorkspaces.canonical = {
  project = "main";
  fields = {
    name = "Canonical checkout";
    sourceType = "remote_managed";
    remoteProvider = "worker";
    remoteWorkspaceRef = "main";
    isPrimary = true;
  };
};
```

Fields reuse the native workspace validator. Reconciliation creates database
records through the native project service; it does not clone repositories,
create worktrees, or resolve worker paths. Remote provider/reference strings
are opaque here; the worker must resolve and authorize them before execution.

Every project with declared workspaces requires exactly one explicit primary.
Keys own stable IDs, independent of display names, exported as `workspace/<key>`
in bindings. An existing workspace requires explicit `adopt = "<uuid>"` and must
belong to the referenced project and company. A primary switch cannot implicitly
demote an unmanaged or differently owned primary: declare and adopt that workspace
first. Native edits/deletes of owned fields, including indirect primary-switch
updates, are rejected by the database ownership trigger.

As with other resource fields, omission relinquishes ownership without clearing
the stored value; use explicit `null` for nullable fields to clear them. Declaring
`runtimeConfig` owns the entire native `metadata` column and replaces it with
the declared metadata plus normalized runtime configuration. Preserve any desired
metadata explicitly when adopting. Omitting an entire previously owned workspace
is rejected, because native workspaces have no safe disabled state; retain its
declaration until an explicit ownership handoff is performed. Existing execution
references and history are never implicitly deleted.

Native agent validators define roles, permissions, adapter settings and budgets.
`reportsTo` names an agent key. Native deployment contracts in
`server/src/deployment/adapter-config.ts` validate execution configuration without
depending on UI form schemas. The supported declaration adapters are:

- `hermes_gateway`: requires `apiBaseUrl` and `credentials.apiKey`; supports
  structured nonsecret `headers` and `payloadTemplate`, `instructions`,
  `paperclipApiUrl`, `sessionKeyStrategy`, `timeoutSec`, `eventReconnectMs`, and
  `pollIntervalMs`. Remote HTTP requires the adapter's existing explicit
  `dangerouslyAllowInsecureRemoteHttp` development escape hatch.
- `process`: requires `command`; supports string-array `args`, `cwd`, string-map
  `env`, `timeoutSec`, and `graceSec`. Runtime environment credentials use keys
  such as `credentials."env.PROVIDER_API_KEY"`; conflicting inline entries and
  reserved controller environment credentials are rejected. This is trusted-local
  execution, not an isolated worker.
- `http`: requires `url`; supports `method` (`POST`, `PUT`, `PATCH`), structured
  nonsecret `headers` and `payloadTemplate`, and `timeoutMs` (milliseconds, matching
  the executor). Nested HTTP header credential references are not implemented.

Unknown fields, malformed values, URL userinfo, inline Hermes API keys, and
well-known authentication headers fail validation. Arbitrary payloads and custom
headers must still contain only nonsecret data; validation cannot recognize
secrets by their values. Other adapters now fail closed until they have a native
declaration contract; an existing UI schema alone is no longer sufficient.
The tested end-to-end provider path here is `hermes_gateway`. Declaration support
does not certify a remote-only execution boundary.

A task bridge declares an existing agent, project, allowed assignees, and a
credential key:

```nix
credentialFiles.bridge = "/run/secrets/paperclip-bridge";
manifest.taskBridges.ingress = {
  agent = "worker";
  project = "main";
  allowedAssignees = [ "worker" ];
  credential = "bridge";
};
```

The token must be at least 32 characters and unique. Rotation or scope changes
require a **new bridge key and a new token**, removing the old declaration in the
same apply. Removal revokes the old native key. Existing native task-bridge
authorization enforces the scope; declaration ownership does not grant extra
request privileges.

## Reconciliation and ownership

Startup acquires a database lease, checks schema compatibility, applies pending
migrations and reconciles declarations before constructing the application and
starting listeners or dispatch services. A failed reconciliation rolls back its
database writes and prevents startup. A database's deployment identity prevents
an accidentally reused connection from becoming a different named instance. Its
manifest owner is likewise fixed: changing the owner or omitting a manifest whose
owner differs from the instance name fails closed rather than leaving the prior
owner's agents and schedules active. A legacy deployment with a matching ledger
owner but no recorded owner pins that owner on apply; plan/check report the update.

- **plan:** read-only transaction; reports resource action and changed field
  names. Never bootstraps users, migrates, writes bindings, or initializes a DB.
- **check:** same read-only computation; exit `0` means converged, `2` means
  differences, `1` means validation/connection/reconciliation failure.
- **apply:** offline operation; refuses while the server/provisioner holds the
  lease. May initialize/start the embedded cluster and migrate. Uses the same
  transactional reconciler as startup, then atomically publishes bindings. Loss
  of its database lease terminates the process before it can continue migrations
  or reconciliation without exclusive ownership.

Plan/check need an already initialized, reachable database. For embedded mode,
run them while the service or a separately supervised PostgreSQL process is
running. They do not start a stopped cluster merely to inspect it. Run offline
apply as the configured service user, with the same descriptor and runtime files.
The descriptor's path is visible in `systemctl cat paperclip-<name>` (or
`systemctl --user cat ...`). Its contents are not secrets.

Renaming a display label preserves its UUID. A second identical apply does not
rewrite resources, rotate credentials or create new account/session records.
Database triggers reject changes to owned fields through ordinary application
routes and services. Operational pauses, spend counters, run/session/issue
history, and unowned fields remain operational state. Increasing `enabled` does
not resume a paused agent or routine automatically.

Removal retains resource history. Agents, companies and routines are paused;
schedules and secrets are disabled; bridge keys are revoked. Projects retain
their records and ownership. Removed credentials cannot be resurrected under
the same declaration key. The bootstrap refuses replacing existing admins or
adopting a non-admin account, and never resets an existing admin's password.

The binding file is mode `0600`, written by rename after the database commit and
directory sync. It contains `version`, `owner`, and resource-key-to-UUID
`bindings`. If publication fails after commit, startup fails; retry reuses the
same identities and republishes. Preserve the owner and declaration keys across
upgrades and restores.

## Migrating the singleton without moving data

The legacy `services.paperclip.enable` interface is retained. It cannot be enabled
alongside `services.paperclip.instances`. Migration is explicit:

1. Record the old database directory/URL, PostgreSQL major version, instance ID,
   encryption key, storage directory, Unix owner and runtime credentials. Take
   and verify a backup.
2. Stop the singleton. Disable its module before enabling the replacement.
3. Use an instance key matching the old persisted instance ID (commonly
   `default`), and retain the old `stateDir` and Unix `user`. Set
   `database.dataDir` to the existing embedded cluster directory when it differs
   from the new default. For external PostgreSQL retain its runtime URL file.
4. Retain the original embedded database and role names explicitly. Upgrade an
   old default role password in PostgreSQL and the protected password file
   together; do not initialize another cluster to change its password.
5. Preserve the original encryption key using `encryptionKeyFile`. Preserve
   storage and other paths in configuration. If the old layout cannot be
   represented by the module-owned paths, use a reviewed descriptor/configuration
   with the native executable until the layout is explicitly migrated.
6. Introduce declarations with `adopt` UUIDs for existing resources. Do not rely
   on matching names. When adopting a routine with an active schedule, declare
   that schedule's existing UUID with `schedule.adopt`; an unadopted active
   schedule prevents reconciliation rather than creating a duplicate. Plan
   against the existing database, then start/apply under the new service
   definition and verify IDs and authentication.

The module does not copy, move, chown recursively, reset or delete databases.
Changing a module name or state root is not a database migration.

## Upgrade, backup and restore

Nix generation rollback is **not database rollback**. Before an application
upgrade, stop dispatch, take a logical database backup with the migration journal,
and preserve the matching application revision and manifest. Preserve the secret
encryption key, runtime credential files, uploaded storage and any workspaces
required for recovery. Database-only backups cannot decrypt local secrets.

The native database backup/restore implementation supports logical backups of
the migration journal, functions, triggers and resource ledger. Use a PostgreSQL
utility version compatible with the server. Never place a password-containing
URL in a shell argument or shell history. Restore into an isolated fresh target,
with the matching key and credentials; verify plan/check, authentication, stable
bindings and secret resolution before starting work.

Declarative startup refuses journal hashes absent from the installed migration
set, including an older binary against a newer schema. Recovery is to use a
compatible binary or restore a compatible backup, not to edit migration history.
An interrupted apply is transactional; an interrupted migration follows the
upstream migration engine's recovery rules. Keep the verified pre-upgrade backup.

## Verification and downstream readiness

Required gates:

```sh
nix build .#paperclip
nix build .#checks.x86_64-linux.module-evaluation
nix build .#checks.x86_64-linux.native-runtime-tools
nix build .#checks.x86_64-linux.declarative-instances
nix build .#checks.x86_64-linux.nixos-module
nix build .#checks.x86_64-linux.split-network
pnpm -r typecheck
pnpm test:run
pnpm build
```

Focused native tests are in `server/src/deployment/`,
`packages/shared/src/deployment-manifest.test.ts`,
`packages/db/src/postgres-utility-credentials.test.ts`, and
`cli/src/__tests__/common.test.ts`. They exercise real PostgreSQL, the real
launcher and local fake HTTP gateway, rather than paid provider accounts.

Initial verification on 2026-09-26 (before the split-control-plane follow-up):

| Gate | Result |
| --- | --- |
| Native package, including locked Rust runner tests | Passed |
| Module evaluation and collision assertions | Passed |
| Packaged native-runtime helpers | Passed |
| Three-instance NixOS/Home Manager VM | Passed: authenticated embedded/external PostgreSQL, real user service, offline apply, restart and reboot persistence |
| Original singleton NixOS VM | Passed |
| Repository `pnpm -r typecheck` and `pnpm build` | Passed after encryption-readiness and startup-import fixes |
| `pnpm check:token-gates` | Passed |
| Deployment and startup regression tests | 32 passed across four files |
| Stable test-runner/shard tests | 24 passed |
| Scoped Git-fixture proof through the stable runner | 66 execution-workspace tests passed |
| Full `pnpm test:run` attempt | Failed in its general-server stage: 22 files / 196 tests failed; 677 files / 13,360 tests passed; later stages were not reached |

Focused tests have proved read-only planning, account authentication,
stable IDs, no-op reapply, pause/spend preservation, ownership guards, task-bridge
revocation and scoped request authorization, adoption/conflicts, transactional rollback, writer fencing, schema
downgrade refusal, real gateway authentication/session separation, fail-closed
launch, encryption-key readiness, and logical backup/restore including encrypted
secret resolution.

Full-suite triage found a deployment eager-import regression; lazy loading fixed
it and all 20 startup tests now pass. The lease-loss assertion timed out in the
full run and passed in focused reruns; its behavior under full-suite contention
remains unclassified. Many disposable Git fixture commits were rejected by the
host identity hook. A scoped Simit fixture runner, combined with this script's
explicit `TMPDIR` support, passes all 66 execution-workspace tests through the
real `run-vitest-stable.mjs` wrapper. Including `lsof` clears the focused
supervisor and exposure-reservation suites. These targeted reruns do not make
the full test gate green.

Simit's optional test command keeps checkout Git policy intact while giving
temporary fixture repositories their own inherited-hook/signing policy:

```sh
nix develop --no-update-lock-file --command simit test --git-fixtures -- \
  npm exec --yes --package=pnpm@9.15.4 -- pnpm test:run
```

Use a Simit build that includes `test --git-fixtures`, and the workspace's pinned
pnpm version. Simit is a development helper, not a package/runtime dependency.
Fixtures must honor `TMPDIR` to participate. If the checkout's parent contains a
Cargo workspace, choose an existing `TMPDIR` outside that workspace before
invoking Simit so disposable Rust crates do not join it accidentally. Keep host
Git configuration intact; tests that deliberately exercise hooks must configure
their own disposable repositories rather than relaxing policy for the checkout.
Existing source-level Railway tests
assume `/usr/bin/ssh-keygen`; the package substitutes the pinned OpenSSH path and
its native-runtime check verifies real key generation.

The follow-up verified Simit `2202df98b77dddc46e46cdaab459a914c91296a1`
in a clean checkout, independent of unrelated canonical-checkout changes:

- Build and all six runner boundary/lifecycle tests passed.
- Full `cargo test --locked --no-fail-fast` through that runner: 483 passed,
  15 failed. Its parent `4055d25` had 477 passed and the same 15 failures.
- Formatting and strict Clippy failed on both revisions with the same affected
  formatting locations and error summaries. The committed runner adds no observed
  failure to those gates; Simit as a whole is not green.

Under Paperclip's pinned development environment and that clean runner, source
tests at baseline `7f3c06dac` and pre-edit branch HEAD `ea7eb17d4` reproduced the
same two Cursor failures and native-session bounded-launch failure. Railway key
generation also failed at both revisions. These targeted source comparisons used
the same installed dependencies and pre-edit build artifacts; they are not a
claim of a clean rebuild/full-suite baseline comparison.

The Cursor fixture had replaced the executable PATH with `/usr/bin:/bin`, where
this host has no Bash. It now preserves the pinned test-host tool PATH while
retaining all path-discovery assertions. Native recovery's synthetic provider
inherited an oversized development PATH: `shell_environment_policy.set` was
11,471 bytes against the unchanged 4,096-byte argument limit. Its fixture now
projects only the fake provider and Node directories, retaining the real runner
and every recovery assertion. Production argument limits and host Git policy
remain enforced. Real deployments with oversized launch arguments still fail;
this fixture change is not a production long-PATH workaround.

Follow-up focused verification: 70 tests passed across six files, including all
39 native-session resume tests, both Cursor tests, native adapter contracts,
reconciliation, credential/publication failure, real-server lease-loss exit and
the closed-profile gate. Repository typecheck, build and token gates passed.
The final namespace VM run passed with actual workspace read denial and
connection denial to both a world-connectable container-engine socket and the
Nix daemon. Its retained log records `PermissionError: [Errno 13]`, and the same
UID successfully connects outside the service namespace. The native package,
helper check, module evaluation, and original singleton VM passed as well.

The Hermes gateway's separate execution suite passed all 30 tests after adding
cancel-before-dispatch, cancel-during-create-response, active-run cancellation,
stop failure and ambiguous-create cases. Its package typecheck passed. The
full Hermes package suite passed 85 tests in nine files, and the repository
typecheck and build passed after the adapter change. The adapter acknowledges
cancellation only before the remote request or after a
successful stop and terminal-status observation; otherwise it records an
unverified request. This does not prove controller restart recovery or end-to-end
controller confinement. Provider create can still be ambiguous after a lost
response; this revision does not manufacture a run ID or claim it was stopped.

The next fixture-isolation pass passed **533 tests across eight files**, including
the full workspace-runtime, CLI worktree, GitHub launcher, sandbox execution,
multi-repository staging and CLI-auth route suites. It:

- projects required fixture tools instead of assuming `/usr/bin` or `/bin`;
- encloses workspace fixture environment changes in cleanup even if setup fails;
- gives hook-copy and hook-failure fixtures explicit repository-local hook paths;
- uses empty templates where the launcher intentionally clears global Git config;
- isolates provider shells and skill lookup from unrelated host configuration;
- fixes a real application failure in `withShallowGitWorkspaceClone`: temporary
  clones now create `.git/info` before adding nested-repository exclusions. The
  regression test explicitly selects an empty Git template.

The remaining focused source failures also reproduce at `7f3c06dac` under the
same pinned tool environment: three higher-level Cursor remote adapter cases,
the anonymous GitHub-launcher image fixture, and the SSH lease fixture. Railway
source key generation remains a separate absolute-path portability failure.
They are unresolved; these targeted baseline comparisons do not classify every
full-suite failure. Packaged OpenSSH verification remains green.

The staged workspace-A gate passed 7,231 tests in 700 files (UI and CLI).
Workspace B subsequently reached a Daytona cleanup fixture that hard-coded
`/bin/rm`; that failure reproduced at the baseline. Commit `91a503678` resolves
the real executable before installing the failure-injection wrapper. Its full
file-sync suite passed all 23 tests, including the assertion that exactly two
cleanup attempts leave no scratch file or warning.

The workspace-B rerun passed 3,625 tests in 277 files (12 tests and two files
skipped by their existing suite configuration). The post-fixture serialized
server lane passed 2,694 tests across 148 files. The earlier full `pnpm test:run`
attempt, started before fixture corrections, failed with 74 tests in eight files
and 13,523 passed. Most failures were in workspace-runtime, whose entire 161-test
file subsequently passed under the scoped runner. The remaining general-server
stage is not green or comprehensively baseline-classified; the passing staged
lanes are not a substitute for a complete successful `pnpm test:run`.

The final native gate run after `439caf84e` passed the package, module evaluation,
native runtime helpers, declarative-instances VM, and singleton VM together.
Repository typecheck, build, and token gates also passed after the Git/fixture
changes. The later Daytona change is test-only.

The separate-node `split-network` VM check passed with `canix cache build
--no-push .#checks.x86_64-linux.split-network`, including a controller restart
and cross-company denial in the final run. Its controller uses NixOS-managed PostgreSQL and the native
declaration/reconciler, while the worker is a separate NixOS VM with a test-only
Hermes-compatible HTTP gateway. The worker's scoped Paperclip key reaches its
company's issue-list endpoint before and after the controller restart, while
the other company's endpoint returns 403; the same callback returns 401 after
revocation. A subsequent in-flight gateway run is stopped exactly once when the
board cancels it; the controller persists an acknowledged cancellation only after
the gateway reports `cancelled`. The upstream check does not exercise remote-only
mode, real Hermes execution, active-run *restart*, or backup/restore. The
separate nixpkgs fixture exercises the additional restart and restore cases
described above.

At nixpkgs PR #567242 commit `ebbe656e268`, [review-worker run
`36306368223`](https://github.com/caniko/nixpkgs-review-gha/actions/runs/36306368223)
built the x86_64-linux Paperclip package and passed `nixosTests.paperclip`,
including the same-controller restore rehearsal and lease-expired SIGKILL
classification. The VM log confirms final callback revocation after restore.
The full Paperclip `pnpm test:run` rerun at `20066db79` exited successfully
after the SSH env-lab fixture correction. The subsequent lease-loss,
owner-fencing and routine-schedule adoption changes passed their focused
integration tests, repository typecheck, build and another full `pnpm test:run`
at this revision. The nixpkgs review below still describes an older source pin;
the current source requires a refreshed package and VM review.

A bounded independent read-only review covered the native adapter contracts,
closed-profile gate, namespace restrictions, examples and fixtures. It reported
no concrete defect in its limited scope, but stopped at its step limit and did
not audit the remaining execution paths or independently run tests. A subsequent
configuration review found that `settings.llm.apiKey` and
`settings.database.connectionString` could place credentials in generated Nix
store JSON; both system and Home Manager instance assertions now reject them.
This is not a complete security review or release approval.

| Readiness dimension | Verdict |
| --- | --- |
| Native packaging and declarative services | Build and native-service acceptance proven on x86_64-linux for the older pin; suitable for isolated staging. The current source passed the complete test gate, but awaits refreshed package/VM review and independent review. |
| Remote-only execution enforcement | Not implemented end to end. The selector refuses startup before imports/credentials/database changes; that refusal is tested, but is not a usable remote-only controller. |
| Trusted-local split-node staging | The nixpkgs VM passed package, callbacks, revocation, in-flight graceful cancellation, lease-expired crash classification without replay, and a same-controller database restore. Ambiguous gateway-create and full independent security review remain open. |
| Complete remote-only split deployment | Not qualified. No run under an enforced remote-only policy exists; complete worker isolation and fresh-controller disaster recovery still need proof. |

**Downstream readiness: not established; this is not a production-ready
contract.** Remaining acceptance work includes:

- Resolve the remaining test failures and complete all stages of the full gate.
- Implement and qualify the remote-only runtime policy across every audited
  startup, mutation, override and dispatch boundary before opening its gate.
- Inject failures at every background-dispatch startup boundary in managed-service
  tests. The fixture's successful graceful restart does not prove ambiguous
  create-response recovery or a stopped worker after SIGKILL.
- Extend the native declaration contracts when additional adapters or nested
  credential projections are needed; unsupported adapters remain rejected.
- Complete the separate controller/worker VM acceptance matrix. Successful
  gateway execution under the complete remote-only policy is still blocked.
- Complete independent review of reconciliation, ownership guards, credential
  boundaries and the downstream contract.

Existing adapter and authorization suites cover parts of these behaviors, but
do not substitute for that complete managed-service acceptance matrix.
