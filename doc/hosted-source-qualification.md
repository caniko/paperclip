# Hosted source qualification

The `Exact-head source qualification` PR workflow checks the actual PR head.
It runs workspace typechecks, the full test command, the build, token gates,
and mandatory Hermes lineage and run-lifetime, PostgreSQL settlement, MCP
admission, real chat-shard, wake-lock and skill-refresh regressions. It installs
only declared dependencies and uses disposable hosted fixture state.

Each lane runs once. The test wrapper writes separate JUnit reports when
`PAPERCLIP_TEST_REPORT_DIR` is set and disables Vitest retries in that mode.
Both the mandatory regression lane and the full-suite lane require reports with
cases and no failures, errors, skips, or retry markers. The full-suite receipt
remains rejected when platform-specific or deliberately disabled cases are
skipped; their coverage still needs an independent disposition. The real nested
chat-shard fixture keeps its reports in its own temporary directory so its
expected assertion failure cannot overwrite mandatory outer-suite evidence.

The separately configured `runner-package` environment runs the complete Runner
Vitest roster without a name filter, including all three final-output benchmarks
once. It first builds the locked Rust workspace binaries and materializes the
hash-pinned Pi distribution for the existing real-snapshot test. The preparation
log, distribution manifest and native-closure inventory are retained with that
job's original evidence; workspace tests do not supply Runner-package credit.

A separate lane verifies the original hosted run that overlaid the exact
successor regression fixture on F645. That run proved RED with completed
assertion failures for endpoint identity, stale SSE, lineage membership, and
replay settlement. Import failures and skipped cases cannot prove RED. The lane
checks the original archive against its pinned SHA-256, verifies the hashes of
its receipt members and the 20 failures across 23 cases, and requires the PR's
fixture digest to match. A changed fixture needs separate evidence. The lane
does not run tests, and expected RED never satisfies a mandatory successor GREEN
gate.

The exact ZIP and its captured GitHub metadata are committed in
`.github/qualification/`. They came from the passing RED lane's retained copy
(run `44322554280`, artifact `14435489415`); the ZIP matches the existing pin for
original run `39157504264`, artifact `12146584669`. The snapshot is not a live
availability check. Keeping only a receipt or digest would lose the ability to
inspect the original logs and recheck the report. Repeating the F645 overlay on
every PR would repeat the baseline install and depend on current runner and
registry behavior. A scheduled refresh would need a trusted producer pinned to
F645 and the fixture, with verified assertions and provider digests; a missed
refresh could still block PRs. The committed copy keeps the original proof
without a refresh or re-execution.

Receipts bind the PR head, base, tested revision, workflow revision, platform,
source lockfiles, raw logs, and reports with SHA-256. The retention job reads
the actual GitHub metadata for current-run artifacts, including the RED lane's
sealed copy, and requires at least 2,592,000 seconds between creation and expiry.
Every required upload uses `retention-days: 31`.
The repository and organization must permit at least 31 days before execution.
Changing a workflow setting alone does not prove artifact retention.
The trusted Stop harness identity job also gates acceptance. Its assertion log
has its own provider-retention readback, retained with the source-proof
artifact readbacks in the source-retention artifact.

The live PR head and base must both match the triggering event. A moved base
rejects the run before application execution, even when its head is unchanged.
Initialization writes `source.json` on refusal, retaining the event identities,
actual attempt, observed checkout, available lockfile hashes, and the refusal
reason with `initialized: false`. The failing step still fails. Sealing binds
that source record and its raw logs; an incomplete initialization cannot produce
mandatory GREEN or expected RED. Empty or malformed reports stay hash-bound in
failed receipts. Provider-retention refusals also write a readback receipt with
the observed metadata and rejection reason before returning failure.

Failed evidence remains available. A retry cannot qualify: fix the source,
publish a successor, and obtain an attempt-1 run. Superseded-head or base evidence
is historical. Receipts stay `qualified: false` until an independent final review
accepts all required checks and artifact bindings. The hosted regression lane
tests initialization refusals, failed-report custody and retention refusals; these
receipt checks do not replace the mandatory application or native qualification.

The existing PR, native composer Stop, and Nix renderer workflows remain
required companion evidence. An application pass does not qualify a different
worker, package recipe, module revision, or dependency lock. The accepted
application revision `da988533a14575d9c7404f410ac8b56fa6319293` remains a separate
baseline; its acceptance does not transfer to this successor.

High-memory Nix package and VM runs use the external review workflow. Its owner
must select an available GitHub-hosted larger runner and establish provider
retention controls before execution. ARM qualification uses a genuine ARM
runner and the full `nixosTests.paperclip` test. An x86 fixture cannot qualify
ARM, and queued or unavailable capacity is not a passing result.
