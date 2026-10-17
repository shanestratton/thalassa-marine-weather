# Anchor safe-area foundation (139-06)

`utils/anchorSafeZone.ts` is the canonical, dependency-free manual geometry rule.
`pi-cache/scripts/sync-anchor-zone.mjs` copies its exact source and SHA-256 into
the Pi and Edge mirrors; `--check` and the parity tests reject drift.

The admission boundary accepts a polygon with 3–64 corners, or 1–8 exclusion
wedges, bound to the current anchor. It refuses crossed/doubled outlines, tiny
areas, unsupported holes/fields/versions, an anchor outside the polygon,
corners outside the enclosing native circle, and wedges covering every usable
sector. A moved anchor or a smaller incompatible native circle requires review.
Original manual points are copied and frozen. Unknown positions or invalid
geometry return `null`, which callers must never present as holding.

The local projection wraps longitude and works at the poles. Polygon edges
include a 1 mm numerical tolerance; exclusion wedge boundaries are excluded.
At an exact pole, true-bearing wedges are refused and a polygon is offered.
The parser supports an enclosing circle of 5–5,000 m. The native circle remains
the backstop; this foundation does not replace any active alarm path.

This checkpoint has **no production callers**. Remaining work is the explicit
finger editor and confirmation, serialized phone persistence and alarm adoption,
fresh account/boat/session fences, transactional move/radius handling, Pi
assignment/capability and relay validation, Shore Watch and Watch rendering,
held database migration, and staged Pi update 8. Preserve the existing GPS
watchdog, distinct-fix confirmation, native EXIT alarms and rollback semantics.
Until the Pi installation is separately verified, say that it watches the
circle and that the custom area is monitored by the phone.

Do not automatically shift a drawn polygon or exclusion wedge when moving the
anchor. The move UI must make clearing/reviewing the custom area explicit,
and failed edits must restore the prior area and native circle together.
No chart geometry, new dependency, backend deployment or installation is part
of this foundation.
