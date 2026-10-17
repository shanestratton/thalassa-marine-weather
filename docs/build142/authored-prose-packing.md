# Exact authored prose representation

The configured142 source exceeded the existing JavaScript ceiling. This change
packs only long literal values in the existing authored display source
`services/reference/skipperReferenceCards.ts`. The source remains byte-identical.
Its normalized source SHA-256 value and 77-literal inventory are pinned in
`scripts/pack-authored-prose.mjs`; other TypeScript paths are excluded.

The 74 unique strings occupy one embedded JavaScript tuple: 17,237 decoded bytes
and 8,692 base64 characters. Each original whole string is one dictionary entry
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
markup, source links, object order and content remain
the original values. This changes no scientific, licence or navigation claim.

Focused proof uses real production Vite/Terser output, compares every returned
card and unchanged country-snippet control against the original, proves the encoded tuple
actually runs, and builds a real independent worker to prove it retains original
prose without acquiring the table or a document reader. Original decoder/UI-pool
bounds suites are also retained. The first fixture failed because Vitest's test
environment kept the production plugin disabled; that failure is preserved in
`work/validation142-authored-prose-first-focused.log`. The repaired fixture sets
the production environment and explicitly checks table presence, rather than
accepting a no-op comparison. The first real configured candidate `611735eef`
still exceeded the ceiling by 2,107 bytes. It combined an unused trip-note cohort
with reference text, retaining values whose original module was eliminated.
That candidate and failed measurement remain preserved. The unused trip target
is removed from the packer; its original source, APIs and features are unchanged.
The reference cohort is actually reachable in the original configured artifact.
The further [shader representation](shader-row-packing.md) requires fresh exact
whole-app size and browser proof; an isolated estimate is not acceptance.

This source-only change performs no native identity bump, signing, upload,
provider activation or deployment. Actual unsigned Mac compilation and physical
file-provider acceptance remain required for the native chart feature.
