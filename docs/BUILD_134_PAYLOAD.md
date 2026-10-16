# Build 134 payload checkpoint

The production JavaScript limit remains **10,643,046 bytes (10.15 MiB)**.
Both changes below remove repeated implementation or static properties; the
existing feature flags and image/icon capabilities are preserved.

## PNG decoding

`scripts/png-inflate-dedup.mjs` redirects only fast-png 6.4.0's decoder import
of Pako to `utils/pngInflate.ts`. That decode-only seam uses fflate 0.8.3,
which jsPDF already uses for PDF compression. The unchanged fast-png parser
still handles PNG/APNG framing, colour formats, filtering and interlacing.
The adapter checks the zlib header and Adler-32 checksum and collects IDAT or
fdAT fragments until the parser requests the completed frame. Other Pako
consumers retain their original implementation. The encoder class is marked
side-effect-free, so an actual encoder import still retains its real codec.

The production-bundle regression compares complete pixels and metadata with
the original parser for RGB, RGBA, grayscale, palette transparency, 16-bit and
Adam7 images, split IDAT/fdAT streams, APNG frames and ICC profiles. It also
embeds the formats with the real jsPDF constructor and rejects malformed
zlib streams. A dependency seam check requires review if fast-png changes.

## Shared SVG properties

`scripts/share-svg-props.mjs` recognises React's imported `jsx`/`jsxs` helpers
after JSX compilation. Exact repeated literal outline properties share
frozen objects. The SVG element, children, dynamic properties, custom stroke
widths, accessible labels and event handlers remain at their original React
boundary. No extra component is introduced. Spread, duplicate, computed or
accessor properties, shadowed helpers and non-app source are skipped. The
transform supplies source maps and only runs in production builds.

The configured build shared properties for **467 SVG elements**. Regression
tests build every exported icon in five real icon modules both ways and
compare the rendered SVG tree, attributes and geometry. Negative cases check
the transform's exclusions, nested SVG edits and source-map content.

## Configured artifact evidence

The builds use the same public GitHub Actions VITE variables in memory; no
configuration values are logged. They include all native release JavaScript
and use the existing release-budget measurement, excluding source maps.

| Source                                              | JavaScript bytes | Headroom |
| --------------------------------------------------- | ---------------: | -------: |
| Baseline `24ea6c3a682e74d089bb2db6850d707f6c37faf6` |       10,681,193 |  -38,147 |
| PNG seam `11ec20a3c510763d7f17b15a4052045f03f5343e` |       10,663,986 |  -20,940 |
| Combined `0a0bf37d802d57993236ff89b9dcb9c248d09733` |       10,638,487 |    4,559 |

The combined checkpoint includes chart-proxy master
`c14828e1f0180fcdc6f59b7080fa8ab8e5a52a11` and browser fixes
`d42668411a5117e443a6bc0b6bc5b8839dbb17f7`. It saves **42,706 bytes** against
the configured baseline. Its complete artifact is 15,150,148 bytes; its main
entry is 24,020 bytes raw and 9,498 bytes gzip, across 408 JavaScript files.

Focused validation: **115 tests across eight suites** covering both production
transforms, logger stripping, PNG/PDF behavior and chart proxy behavior;
scoped ESLint, Prettier and `git diff --check` pass. The final release still
requires the normal hosted checks on its exact final source and configured
artifact. The narrow remaining headroom must not be interpreted as permission
to raise the existing budget.
