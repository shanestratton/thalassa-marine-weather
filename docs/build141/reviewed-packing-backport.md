# Reviewed display-data representation

The sharper-satellite composition at `ce0be4ab991644fc913d84a3f609cfcde3561d8e`
compiled but exceeded the unchanged JavaScript limit by16,284 bytes. This packet
backports only the final reviewed build142 representation from
`977bfbd0fbb214c54f39c8a4ebffbc5b286b5072`: two build-time packers, their original
tests and the two authored-prose import/plugin lines in Vite. It changes no
feature, original display copy, provider, flag, dependency, decoder or ceiling.

The authored packer admits only the unchanged, SHA-bound
`services/reference/skipperReferenceCards.ts`:77 original cooked literals,
74 unique strings and one embedded8,692-character JavaScript tuple. Its existing
bounded decoder restores exact values. Other TypeScript files, module paths,
tagged/dynamic templates, keys and worker builds remain excluded. The earlier
build142 candidate's unused TripOverview cohort is deliberately absent, so
original dead-code elimination is preserved. The four ordinary UI pools and
their caps are unchanged.

The already-reviewed Mapbox source remains exactly pinned. All89 GLSL strings
and139 ordered chunks remain identical; the same two existing bounded tuples
now encode each complete chunk as one dictionary word. Their65/74 rows expand
to78,197/101,867 bytes under the original128,000-byte caps. The encoded tuples
shrink from54,928 to45,552 characters without storing executable code as data.
Serialized callbacks, lexical-binding/CSP guards, APIs and runtime options stay
unchanged. Every encoded byte remains ordinary counted JavaScript.

Two isolated real Vite/Terser reference graphs estimate7,817 bytes saved with the
app's already-shared decoder; the exact shader tuples save9,376 characters.
The combined17,193-byte estimate is not a configured whole-app result. Final
chunk sharing, names and pool interactions still require the release owner's
exact configured build and unchanged all-JavaScript/total-asset checks.

The original source tests cover exact round trips, cooked escapes, source
reversal, content/API parity after production minification, worker exclusion,
all GLSL bytes and callback bindings. Actual browser capture proof uses the
previously reviewed external preserveDrawingBuffer capture context for both
original and packed SDKs, with the same strict CSP, real workers, shader checks,
red-pixel threshold and12-second deadline. That capture option is not added to
the product. The earlier default-buffer WebKit post-idle capture failure and
ordinary-render pixel proof remain historical evidence. This packet alone does
not establish a whole release, native compile, signing or TestFlight upload.
