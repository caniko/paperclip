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

This establishes source preparation. Application qualification and deployment
acceptance require the exact signed successor that imports these bytes.
