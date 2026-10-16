# Exact interface strings in bounded tables

The production representation now includes exact compiler-normalized JSX text
and shorter static interface strings. The post-JSX transform still replaces
only matching primitive string literals; expressions, import/asset paths,
directives, keys and tagged templates keep their evaluation. SVG paths already
handled by the existing path pool are excluded from this pool.

Up to four independent tables use the existing decoder without changing its
64,000-byte encoded, 128,000-byte expanded JSON, 4,096-row, 8,192-word or
256,000-character output limits. Selection caps each table at 240,000 restored
UTF-16 code units. The aggregate is bounded to four tables, 16,384 entries and
960,000 code units. No runtime or remote data enters the tables and no new
runtime dependency is added.

The focused string/class/path suites pass 23 checks. Production Vite/Terser
fixtures compare actual rendered HTML, compiled JSX entities and whitespace,
conditional evaluation and event handlers. Multiple tables retain exact index
order and immutable outputs; excess tables, expansion and long words are
refused. The original decoder's bounds and checksum checks remain unchanged.

Task evidence: `work/validation138-ui-packing-first.log`. The actual configured
app budget and browser verification are separate release checks; no saving or
completed release is asserted by these source tests.
