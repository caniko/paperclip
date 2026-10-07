# Hosted source qualification

The `Exact-head source qualification` PR workflow checks the actual PR head.
It runs workspace typechecks, the full test command, the build, token gates,
and mandatory Hermes lineage, PostgreSQL settlement, MCP admission and real
chat-shard regressions. It installs
only declared dependencies and uses disposable hosted fixture state.

Each lane runs once. The test wrapper writes separate JUnit reports when
`PAPERCLIP_TEST_REPORT_DIR` is set and disables Vitest retries in that mode.
Both the mandatory regression lane and the full-suite lane require reports with
cases and no failures, errors, skips, or retry markers. The full-suite receipt
remains rejected when platform-specific or deliberately disabled cases are
skipped; their coverage still needs an independent disposition. The real nested
chat-shard fixture keeps its reports in its own temporary directory so its
expected assertion failure cannot overwrite mandatory outer-suite evidence.

A separate lane overlays the exact successor regression fixture on F645. It
requires completed assertion failures for endpoint identity, stale SSE, lineage
membership, and replay settlement. Import failures and skipped cases cannot prove
RED. Its receipt records both revisions and the fixture digest. Expected RED
never satisfies a mandatory successor GREEN gate.

Receipts bind the PR head, base, tested revision, workflow revision, platform,
source lockfiles, raw logs, and reports with SHA-256. The retention job reads
the actual GitHub artifact metadata and requires at least 2,592,000 seconds
between creation and expiry. Every required artifact uses `retention-days: 31`.
The repository and organization must permit at least 31 days before execution.
Changing a workflow setting alone does not prove artifact retention.

Failed evidence remains available. A retry cannot qualify: fix the source,
publish a successor, and obtain an attempt-1 run. Superseded-head evidence is
historical. Receipts stay `qualified: false` until an independent final review
accepts all required checks and artifact bindings.

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
