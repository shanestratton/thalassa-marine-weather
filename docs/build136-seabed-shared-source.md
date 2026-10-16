# Build 136: seabed shared authenticated source

`AttachSeabedOptions` now accepts `selfDocument?: () => Promise<unknown | null>`
and optional `sourcesDocument` with the same shape. Root wires the shared
authenticated read-session cache into the former. Omit source metadata until an
authenticated cache provides it. No endpoint or caller may provide a source URL.

`SignalkSelfReader(fetch, origin, now?, documents?)` retains its existing two- and
three-argument constructors. With the fourth callback it accepts only the fixed
`vessels/self` and `sources` targets, and a null/failed callback never falls back
to discovery or REST. Original source envelopes are retained.

Missing sources metadata only leaves `sounder_product` unknown. It does not
disable an existing opted-in capture: the real runner regression records fresh
fictional soundings after its existing 500 m start/end privacy trim with no
product metadata and no source HTTP. Four focused reader/runner tests, Pi
TypeScript and scoped ESLint pass. The existing physical/SQLite/installation
proof requirements remain; no server, stage, track-Signal-K or live Pi change is
included.
