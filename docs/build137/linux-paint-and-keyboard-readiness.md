# Linux paint and keyboard readiness diagnostic

The second full Linux validation's keyboard shard 3 retained real failures:
compact/large-text WebKit tide plots had zero counted curve pixels on both
attempts, and two Wake editor keyboard cases briefly placed the focused input
under the Save footer before passing on retry. The original artifact is
`12077684619` from run `38968496629`, 198811640 bytes, SHA256
`bce05cab2bf2b4bda9208ca5cdc115122a9626097f377cf2baa1fc72a7414b49`.
It was fetched with bounded read-only GETs and verified before selected entries
were extracted outside the repository.

The actual tide failure screenshots are blank: curve, grid and hour-axis text
are absent. A compact trace still shows a nonzero 829 by 243 canvas backing
store. This is not evidence of a false colour threshold. Source timing, drawing
state and a persistent rendering defect remain distinguishable possibilities
until the focused Linux run reports initial and settled pixel measurements.

The tide spec now waits at most five seconds for its original **more than 100
real curve pixels** below the current caption, then retains its original axis,
visible-space, bounds, button, focus and no-expansion assertions. Every sampled
pixel count, backing size and current canvas transform is attached, including
on failure. All unfiltered page errors must also remain zero. No artificial
draw, pixel colour substitution, threshold reduction or product canvas change
is introduced by this diagnostic.

The Wake spec previously waited for the sheet's outer bottom and partial
viewport intersection. That can complete before the 200 ms max-height animation
and the existing keyboard guard's final 360 ms focused-field correction. It now
waits at most five seconds for the actual focused field to fit fully inside the
scroll body above the footer, with a successful centre hit-test. The original
final input/footer containment assertion remains. Sampled timing, body/footer/
field bounds, scroll position and focus/hit-test state are attached on success
and failure. Production keyboard timing and layout are unchanged.

This change is a bounded readiness diagnostic and test synchronization repair.
A persistent blank tide plot still fails at the original threshold and requires
a product repair. Linux proof is required before classifying that cause or
resuming the full release matrix. Root's four route-worker benchmark tests are
also retained in the existing single-worker `@pixel` graphics lane, with every
original latency and negative-control assertion unchanged.

## Controlled backing-store repair candidate

Focused Linux run `38975258101`, exact source `72fb05fa0`, confirmed that
readiness alone does not resolve the tide defect: the same 15 WebKit cases
remain at zero curve and axis pixels throughout five seconds. The compact
300 px trace retains 829 by 243 backing pixels, 22.33 px of visible plot and an
unchanged 3 by 3 transform. Accumulated scaling and an ordinary short paint delay
are therefore excluded by that recording. Context-loss state was not recorded.
The 37 other Tide/Wake cases and all 12 isolated graphics/worker cases passed,
without retries.

The narrow product candidate replaces unconditional canvas backing-size
assignments on every draw with rounded integer dimensions assigned only when
they change. Zero-size hosts leave the surface intact, and an absolute DPR
transform makes redraw independent of whether the surface was recreated. The
memo comparison also includes the previously omitted `domainBuffer` prop.
Layout, card dimensions, CSS sizes and curve/axis thresholds are unchanged.
Three lifecycle regressions cover repeated fractional-DPR redraws, a hidden
host becoming visible, and changed vertical headroom. They and four existing
official-tide display cases pass. The diagnostic now records context-loss state
when the engine exposes it, using -1 for an unavailable API.

This is a controlled candidate for the repeated surface-recreation path, not a
claim that the Linux cause is resolved. A new exact-source Linux pixel run must
pass before acceptance. Its Tide/Wake evidence is uploaded before the separate
graphics benchmark command so a persistent failure is available immediately.

The idempotent-size candidate `cf5d13ceb` passed all 70 local Chrome/WebKit
tide/wind-tide cases but left 14 blank WebKit tide cases in Linux run
`38976959026`. Artifact `12078963668` was available before the graphics command
finished: 5641162 bytes, SHA256
`ec3b8d9b8848a7abbab4c758d79f4c52c659ea7e8af7d8389273b3a9ea2bb68a`.
Its failed compact samples remain zero for five seconds with an 830 by 243
backing store and a 3 by 3 transform; the context-loss API is unavailable (-1).
The size change alone is insufficient and is not treated as a successful repair.

The following candidate coalesces effect, ResizeObserver and theme requests into
one animation-frame paint after layout, and cancels obsolete paints on cleanup.
Four lifecycle regressions and the four official-tide tests pass, including
unmount cancellation. A separate diagnostic case opts into a bounded command
recorder for method counts, finite numeric arguments and backing-size writes.
All original cases run without that recorder, so instrumentation cannot be the
reason their rendering passes. The diagnostic retains the original actual
curve, axis and visible-space thresholds and adds no artificial draw. Exact
source Linux proof is still required.

Linux run `38977828070` on exact source `47ac5206f` still has 15 blank
original WebKit tide cases. Its early Tide/Wake artifact `12079294834` is
6127128 bytes, SHA256
`bb5c335e30323b11ef09b7d6e0ae6c774b594440fb3a9e192fc56d691cb6a59c`.
The original compact 300 px case remains zero throughout 5.3 seconds. The
separate instrumented case first records zero pixels after two finite complete
draw passes and only one backing-size write per dimension, then passes after
its third draw. That instrumentation-sensitive pass is not acceptance, and the
animation-frame change alone is insufficient.

The next diagnostic records all nontransparent/opaque pixels and paint below
the caption, independent of the original curve/axis colour thresholds. It also
records canvas, container and plot CSS rectangles, the full context transform,
global alpha/compositing/filter state, and save/restore/clip/reset counts in the
isolated recorder case. That case alone creates a separate unmounted canvas
with the same backing size and DPR transform, paints a known rectangle into
that control and immediately reads one pixel. It never paints into the product
canvas. All original product cases remain uninstrumented and retain their
existing real-pixel, layout, page-error and no-expansion guards.
