# Exact shader row representation

The existing pinned Mapbox main-renderer packer already replaces 89 authored
GLSL literals by 139 ordered chunks of at most 2,048 code units. This change
keeps every original shader/chunk byte, span, order, source SHA, serialized worker
callback, runtime export and public API. Only the contents of its two existing
embedded data tuples change. No JavaScript program is stored as data.

Each complete original chunk is one dictionary word, and each decoded row is a
single index. Embedded whitespace stays inside that word. The unchanged
`decodeClassNames` therefore restores the exact chunk without adding or removing
spaces. Existing checksum, byte, row, dictionary, entry and 256,000-character
expansion checks remain intact. Build admission additionally bounds each chunk
to the existing 2,048 limit before compression. No new decoder or runtime path,
DOM record, provider, feature, package or bundle ceiling is introduced.

An isolated exhaustive data-only benchmark compared 636 admissible combinations
of bounded split, dictionary ordering and standard zlib settings. The reviewed
source-order split after row65 keeps the same two pools, now 65/74 rows with
78,197/101,867 decoded bytes, below the original 128,000-byte limit each. Standard
level9 zlib yields 17,712/27,840 base64 characters: 45,552 in total versus the
previous 54,928. The existing actual decoder reproduced all139 chunks and all89
joined GLSL strings for the leading twelve benchmark results before selection.
The benchmark is `work/measure142-mapbox-row-packing.json`; it is an isolated
data estimate, not a full release size claim.

Original exact GLSL, whole-source reversal, callback bytes, CommonJS export/API,
worker binding and strict CSP/real worker/shader/red-pixel assertions remain.
New checks cover the reviewed two pool inventories, whitespace/Unicode,
checksum refusal and unchanged resource bounds. Fresh whole-app TypeScript,
configured production size and the original 12-second Chrome/WebKit rendering
proof are required for this final source. Historical budget and fixture failures
remain evidence. Native identity, permissions, signing and deployment are unchanged.
