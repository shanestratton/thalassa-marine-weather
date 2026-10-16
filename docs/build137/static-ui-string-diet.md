# Static UI text representation

Build137 source `3702b2d39132c31dead0b1a826abf8d9d2c9ce72` shares long, immutable UI strings through the existing bounded string decoder. Public content remains exact, including Unicode, repeated spaces and line breaks. The transform leaves module and asset paths, object keys, directives, tagged templates, expressions and handler order intact. It only visits production App, component and page TSX files.

The table uses the existing decoder without expanding its limits:128000 raw bytes,64000 encoded characters,8192 words,4096 values and240000 restored characters. Selection is deterministic and drops optional entries when a bound is reached. Remaining literals stay in their original representation. The production build shared1271 values across1175 literal occurrences.

The configured production checkpoint measured10,590,992 JavaScript bytes against the unchanged10,643,046 limit, leaving52,054 bytes. Total output was15,092,258 bytes against18,874,368. The main chunk was82,972 bytes raw and55,336 gzip, within819,200 and256,000 respectively. This is a source checkpoint with native136 identity, not the final137 release.

Four new semantic tests plus ten existing class-table tests passed. They check exact reconstruction, deterministic bounds, compiler-sensitive exclusions and actual Vite/Terser output rendered through React, including conditional evaluation, property order and click handlers. Whole-app TypeScript passed. Full final-source CI, startup performance checks and native137 verification remain required before release.

Local evidence: `outputs/Build137 static UI string checkpoint.json`, `work/validation137-ui-strings-first.log`, `work/validation137-ui-strings-tsc.log`, and `work/build137-configured-ui-strings-3702b2d39-measurement.json`. The earlier over-budget source checkpoint is retained; no feature or budget assertion was removed.
