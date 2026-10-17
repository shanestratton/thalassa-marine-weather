# Exact authored prose representation

The configured142 source exceeded the existing JavaScript ceiling. This change
packs only long literal values in two existing authored display sources:
`services/reference/skipperReferenceCards.ts` and
`services/TripOverviewService.ts`. Both source files remain byte-identical.
Their normalized source SHA-256 values and 77/32 literal inventories are pinned
in `scripts/pack-authored-prose.mjs`; other TypeScript paths are excluded.

The 106 unique strings occupy one embedded JavaScript tuple: 20,428 decoded bytes
and 10,640 base64 characters. Each original whole string is one dictionary entry
with a one-token output row. The existing `decodeClassNames` already supports
that representation; all checksum, byte, output, dictionary, row, entry-length
and freeze checks remain unchanged. Every encoded byte still counts as
JavaScript, and total artifact limits remain unchanged. No fetch, DOM record,
new runtime package, executable text or additional UI pool is introduced. The
four existing UI pools and their selection are unchanged.

Only compiler-cooked string literals and untagged templates without expressions
are replaced. Tagged/dynamic templates, imports, URLs, keys, directives and
literal types remain unchanged. The plugin is disabled for independent worker
builds. Existing country detection, both hemisphere APIs, shared card identities,
all country-snippet fields, markup, source links, object order and content remain
the original values. This changes no scientific, licence or navigation claim.

Focused proof uses real production Vite/Terser output, compares every returned
card and country-snippet value against the original, proves the encoded tuple
actually runs, and builds a real independent worker to prove it retains original
prose without acquiring the table or a document reader. Original decoder/UI-pool
bounds suites are also retained. The first fixture failed because Vitest's test
environment kept the production plugin disabled; that failure is preserved in
`work/validation142-authored-prose-first-focused.log`. The repaired fixture sets
the production environment and explicitly checks table presence, rather than
accepting a no-op comparison. Full configured size must be measured separately.

This source-only change performs no native identity bump, signing, upload,
provider activation or deployment. Actual unsigned Mac compilation and physical
file-provider acceptance remain required for the native chart feature.
