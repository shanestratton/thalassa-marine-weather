# Build 136 lossless timezone table packing

The production build keeps tz-lookup 6.1.25's complete original grid and all 438 timezone strings in their original order. Its lookup function remains byte-identical after restoring only the two private data initializers. The CommonJS export bridge becomes an equivalent default ESM export. Development keeps the published module.

The exact package/source and both data hashes are pinned before the AST transform:

- Source: `906852259d2157fa80d44eaa8c170ab731ae6497a0a0a066452b79a43125c8d4`.
- Grid: `623da86083ac6d0de9bea26218a597091177ed016c6f74171273755e141b7799`.
- Ordered timezone array: `2f051ef999e6a2727ea57354c24e8f6180d4fab1d73dc63c1ad4216b8549d18b`.

Only the representation is compressed. The existing CC0 package data, geographical boundaries, coordinate coercion/validation, dateline and pole behavior remain unchanged. The app's already shared fflate decoder receives at most 44,000 encoded characters and a fixed output allocation below 80,000 bytes. It verifies the zlib header, exact output length, Adler-32, JSON shape, grid length and timezone count. There is no remote input, fetch, provider query, evaluation of decoded code or guessed timezone. Unknown package/source/table bytes fail the build.

Eighteen unit/timezone/date tests pass, including exact reconstructed-byte equality, unchanged function code, worldwide results, quadtree edges, dateline, poles, invalid coordinates, coercions and corrupt/short/oversized decode refusal. Actual Chrome and WebKit each matched 11,056 world/boundary results against the published original module with no network requests. The browser proof is in the standard keyboard test list.

The actual configured comparison used the same public release-variable mechanism and existing limits. PDF-only source `173cfeaf5871f1fadfe26b41e5cc5f90420df82b` measured 10,677,905 JavaScript bytes. Packed-timezone candidate `f5914da326db73765cd84b31390ef8b41198feb0` measured 10,642,954 bytes, saving 34,951 bytes. Combined with the PDF cut, the original 10,725,376-byte checkpoint saves 82,422 bytes and has only 92 bytes under the unchanged 10,643,046-byte limit. This is a measurement of the earlier checkpoint; later build-136 features require a fresh complete configured measurement and further headroom. No release threshold changes.
