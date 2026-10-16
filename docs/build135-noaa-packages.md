# Bounded NOAA record packages

This checkpoint adds an explicit public NOAA format for cells whose complete
conversion exceeds the existing 16 MiB decode/resident ceiling. It does not
raise that ceiling, the 48 MiB normal / 16 MiB plotting resident budget, or the
128 MiB account storage allowance. It is not a publisher activation. The
remaining acquisition queue stays stopped and the reviewed monolith converter
and runtime policy stay unchanged.

## Format and authority

One package remains one logical US cell, with its original edition, update,
issue date, bounds, source ZIP hash, root metadata and layer metadata. Complete
features keep their values and original layer ordinals. Features are never
clipped, rounded, simplified, silently dropped or relabelled as smaller cells.
The producer verifies exact original feature values at every ordinal before
writing. An individual feature that cannot fit fails conversion.

The manifest is at most 128 KiB. At most 32 immutable SHA-addressed parts are
allowed, each at most 4 MiB. Contiguous ordinal spans, totals, part bounds,
geometry, identity and checksums are validated. Each part can hold only one
span for a given layer. FeatureCollection metadata, including empty layers,
occurs once in the manifest. M_SDAT is not duplicated between parts.

The catalogue variant has `chart: null` and `zip: null`, plus an explicit
`package` descriptor. Older clients therefore continue to show the conversion
as unavailable. A new client first reserves the original ZIP plus manifest and
all parts against the same 128 MiB account allowance, then saves and verifies
the ZIP. Sequential part downloads are validated in the existing parse Worker,
saved and read back. Installation decode also holds a lease in the shared
resident ledger. No package parse falls back to the main thread. The existing
same-cell mutation lock accepts a one-use, current-account staging authority
only after every part passes. No partial cell is made renderer-visible.

Files live under an account-hashed, manifest-hashed directory. Native storage is
the existing backup-excluded open-chart Library location; web storage uses a
separate package namespace. Cancellation or identity changes revoke activation.
Incomplete files retain their quota reservation until exact owned cleanup is
verified; uncertain filesystem errors do not free space on paper. Withdrawal
and removal still compare the exact installed office, revision and content
hash, preserving a subsequent manual/Pi replacement.

The reservation also closes the kill window between registry activation and
the download row's final identity write. Withdrawal/removal checks the current
package inside the existing cell lock against an account-owned, durably
reserved manifest and its verified original ZIP hash. It reconciles a newly
active conversion even if the row still names its old hash or says incomplete.
A manual/Pi replacement or another account's package remains untouched. Any
uncertain manifest/source proof leaves live metadata, bytes and quota intact.

## Bounded consumers

The normal vector renderer, point/segment hazard queries and hazard report
queries load complete request windows locally. They scan relevant parts
sequentially, retain whole intersecting features and release borrowed indexes
and merge leases when detached. The map detaches its previous package sources
before admitting the next package view. Missing parts, corrupt bytes, a revision
change or any resident cap failure returns unavailable/unknown, never a
truncated clear-water answer. There is no package WAN or Pi fallback.

The displayed Mapbox source owns an additional reference to its package lease.
Unrelated memo eviction/cache clearing cannot release its charged geometry;
only actual source detach/replacement or map removal releases that owner. A
merge invalidated before it can acquire display ownership is refused. Browser
and unit regressions clear the memo while a real source remains mounted and
verify that the same resident bytes stay charged.

Chart datum reads and underway lookahead now use complete bounded request
windows too. Every relevant side of a dateline-crossing cone must load before
that logical cell counts as covered. Borrowed views remain charged until all
query candidates have been discarded, then release even on early refusal.
Missing parts or any cap failure produces unknown/partial coverage. Package
indexes are not retained in the legacy three-cell lookahead cache.

Generic whole-cell reads explicitly refuse package cells, including stale
cached monoliths. Inshore whole-cell geometry and lead-overlay consumers do not
yet have explicit package-window adapters. They cannot claim complete package
coverage; their window behavior requires a separate review before full
readiness or acquisition queue restart is claimed.

The new Worker protocol accepts only explicit US public packages. Licensed
boat charts remain in their existing RAM-only path and are not sent to this
protocol, the publisher or any new external endpoint.

## Retained public-source proof

The reviewed one-cell proof used the already retained NOAA US3AK1EX, edition 1,
update 0, issued 2026-03-16. Original ZIP: 1,816,844 bytes, SHA-256
`70e5ebfb55e597df0088b2a889c4439d702168d375815f1f636e7bc684dd8875`.
The unchanged stable GDAL 3.13.3 image was
`sha256:94c4c37740585d2a911cd5336366986ff13ae777f540458297fcefb4c359e048`.
The separately bundled package CLI SHA-256 was
`2392d0d70b1c6126500a1a41779d85395ea91b6bdd5edc0bd3b8530cbf4c2a22`.

One server-owned, 600-second invocation with one CPU, 768 MiB, no network and
bounded temporary/output storage completed successfully. The stopped container,
inspect/log receipts, source originals and prior failure remain retained. This
was a diagnostic conversion, not a readiness or publication advance.

The original 19,236,780-byte conversion contains 12,340 features. All original
features were retained in five parts of 3,921,346 / 4,191,556 / 4,185,022 /
4,187,349 / 2,749,693 bytes. Manifest: 6,906 bytes, SHA-256
`7b1078f5eff8f69a47cf55ded8dd09ca207f9dc6e2ff93fe79c3e2cb88e385f3`.
The combined original plus package reservation is 21,058,716 bytes. Full-cell
source value SHA-256 is
`90832b72d189900f9f923faed87f82c57c12efbf609306c7d26d2e29a6ec61f0`.
The previous 96-ready catalogue and original ZIP hashes remained unchanged.

## Reproducible validation

`playwright.noaa-package.config.ts` runs the real catalogue UI, Filesystem,
Worker, normal ENC renderer and local hazard queries in Chrome and WebKit.
Synthetic cases generate their large public-format values at runtime; no large
chart or private boat data is committed. They exercise a genuinely new browser
context with transferred IndexedDB state and zero WAN requests, incomplete
download cancellation, corruption, account transitions, bounded refusal and
manual replacement preservation. Rendered feature counts are checked and map
screenshots retained. An additional case uses the retained actual public-source
artifact via the outside-checkout `NOAA_PACKAGE_PROOF_DIR` directory. That case
is explicitly skipped when the reviewed artifact is absent; the two synthetic
cases always run. Browser evidence is not physical iPhone memory acceptance.

Focused unit tests cover lossless values/ordinals and metadata, malformed
manifests and geometry, sequential verified staging and one-use activation,
auth changes, retained failed journals, complete bounded windows, corruption
and registry races, shared resident caps, merge lease disposal and stale
monolith refusal. Existing map/report/cache regressions remain in force.

Build a separate server artifact with
`node scripts/noaa-enc/build-package-converter.mjs <new-outside-checkout.mjs>`.
It refuses an existing artifact and does not alter the reviewed old CLI. A
future package-aware staging/publishing plan, inshore/lead consumer decisions,
the exact configured production bundle, independent review and normal release
checks remain required before queue restart or activation.
