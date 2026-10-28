# Deployment migration provenance

The deployment schema was regenerated with `pnpm db:generate` on the exact
source `906c4171ef11c68130fe1e81d1da7f25f88a91ce` in GitHub-hosted attempt 1 of
[run 37860249790](https://github.com/caniko/paperclip/actions/runs/37860249790).
The generated candidate is `0319_exotic_spiral.sql`, with its Drizzle snapshot
and one appended journal entry. Drizzle's normal pruning retired snapshot 0314.

The superseded provisional `0295_nostalgic_rhodey.sql` had no journal entry and
collided with upstream's migration 0295. The hosted preparation preserved that
entire original and separated the custom SQL starting at
`CREATE FUNCTION paperclip_deployment_guard()`. Drizzle generated the table and
indexes against the canonical upstream metadata; the original guard functions
and triggers were then appended byte-for-byte. The resulting SQL is identical
to the original, under its newly generated migration number.

| Bound item | SHA-256 |
| --- | --- |
| Original and resulting SQL | `ac20d3f6626b23aaf07e7bc7f6502bbcd728a2808d4b4adb56b2116bb30e6412` |
| Custom guard SQL | `e94158c17367fb41205c03007702d5ccf2f9eb3c2d2ad4432f35133dd02e580c` |
| Generated journal | `491666a481136f536e8361a783b5434e5b90e59363db391d7a83058f3e265d48` |
| Snapshot 0319 | `5f92a8572c24fe21b3956cf8a059c95d4c20dd316bb57757c8176c826ab86bcc` |
| Imported binary patch | `b82baa09d2e46003ad75544df3c6b962bae38e342d0f8fe669341238f544dc36` |

The preparation passed migration numbering, migration safety and the snapshot
drift assertion. Artifact `11586456015` contains the original SQL, generated
SQL, patch, snapshots, logs and source/member receipts. Artifact `11586146982`
contains the retention readback. Both downloaded archives were verified against
the provider's SHA-256 digests; their actual lifetimes are 2,678,399 seconds.

## Upstream master integration (2026-10-18)

The preserving merge of upstream `27709a99b1a2d3f1e58ab77d5a0e6b48d4626bc1`
keeps its complete journal through `0354`. Two successive `pnpm db:generate`
invocations regenerated the branch additions against that metadata:

| Previous name | Combined name | Executable SQL SHA-256 |
| --- | --- | --- |
| `0319_exotic_spiral.sql` | `0355_sweet_titanium_man.sql` | `ac20d3f6626b23aaf07e7bc7f6502bbcd728a2808d4b4adb56b2116bb30e6412` |
| `0320_previous_richard_fisk.sql` | `0356_perpetual_manta.sql` | `e9bfec1b4c74697c941a0791f50000550ccdf211fda8161aad82bdeaa6e75d79` |

Both executable files remain byte-identical to their original branch versions.
The first generated table/index prefix is unchanged; its original guard suffix
is retained in full. Drizzle generated the snapshots and appended journal
entries, and its normal pruning leaves snapshots `0352` through `0356`.
Existing database rows retain their original hashes, IDs and timestamps; the
hash-based upgrade path recognizes the renumbered SQL without reapplying it.

Local regeneration establishes source preparation only. Hosted qualification of
the exact successor, including fresh bootstrap, authentic-history upgrades and
snapshot drift, is still required. Earlier hosted receipts above apply to their
recorded source; they do not qualify this merge or authorize deployment.

## Upstream master integration (2026-10-29)

Upstream `0e365768f` extends the journal through `0397`. The fork migrations
keep their SQL bytes and follow it:

| Previous name | Combined name | Executable SQL SHA-256 |
| --- | --- | --- |
| `0355_sweet_titanium_man.sql` | `0398_sweet_titanium_man.sql` | `ac20d3f6626b23aaf07e7bc7f6502bbcd728a2808d4b4adb56b2116bb30e6412` |
| `0356_perpetual_manta.sql` | `0399_perpetual_manta.sql` | `e9bfec1b4c74697c941a0791f50000550ccdf211fda8161aad82bdeaa6e75d79` |
| `0357_deployment_environments.sql` | `0400_deployment_environments.sql` | `b435bb7c9cea086298a29e8a933f281d8f39e2cb0ca9cde4158151a468ff6ef7` |
| (new) | `0401_deployment_budget_guard.sql` | `7f825c303b1d7d57fd5c4104cd35a747df6f6cae29ab57fac467aad63b872b94` |

`0401` holds only what the refreshed upstream deployment contribution adds beyond
the applied deployment SQL: the budget-policy guard function and trigger. Its
Drizzle snapshot is generated from the merged schema; snapshots `0394` through
`0397` and `0401` remain after pruning.
