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

The two-case state-only Linux probe `38978712187` on `bd8ce5924` distinguishes
the grid-only defect from a completely transparent surface: the failed original
case retains 168 nontransparent CSS-pixel equivalents, none above alpha 128,
and maximum alpha 15. Its canvas and container are both 276.5 by 81 CSS pixels;
the transform is 3 by 3 without skew or translation, global alpha is 1,
compositing is source-over, and the elements have no opacity/clip/transform
change. The isolated recorder has balanced saves/restores, no clip/reset and no
nonfinite arguments; its fresh control paints immediately while the product
still has grid-only pixels. Its third product draw passes. Artifact
`12080057449` is 440124 bytes, SHA256
`147c6889d5fc59b17f5e56f2364b65dae6fbe3e7db6e9a8c94ba2091ef331fa7`.
This is diagnostic evidence, not release acceptance or a proven root cause.

The next narrow product candidate lets static full-size CSS size the absolute
canvas before layout is read, removing imperative CSS width/height assignments
from the draw path. Integer backing-store assignments remain idempotent. This
separates CSS layout sizing from bitmap paint without extra repaint loops,
changing the card's bounds or changing any real-pixel requirement. Exact-source
Linux proof is required before accepting this sizing candidate.

Static-sizing source `78676bf57` passed all 40 local Chrome/WebKit tide-footer
cases, but Linux diagnostic run `38979184594` still fails the original compact
case with the same grid-only pixels and unchanged bounds/state. Its artifact
`12079853186` is 440088 bytes, SHA256
`3408c0ef0629be6c403da6578baed8f211c06473b9e9a79291499eaf3b59995c`.
The sizing change is therefore not accepted as a rendering repair.

The isolated recorder next retains at most four draw-pass summaries: path
bounds for grid/glow/curve and fills, native stroke/fill colours and context
state, each hour-label position/font, document font-loading status, and theme
class/CSS variable readiness. All native calls keep their original receiver
and arguments; there are no extra product draws or pixel reads during draw.
The original compact case remains free of method interception, so a probe-only
pass cannot satisfy acceptance.

The native-state probe on source `182dd822a`, Linux run `38979690246`,
retains valid identical draw-2/draw-3 coordinates and opaque colours despite
their different raster result. Both have loaded font status and populated
theme variables. The curve occupies logical y49–64 and the labels y80 within
the 81 px canvas. Artifact `12080356977` is 447973 bytes, SHA256
`e9f75aff5f0210f531638653de474220364932b576bd45ef6e95a18d2ad8234c`.
Independent scans of a failed screenshot place grid lines about 195.5 backing
pixels apart, three times their expected DPR-scaled 65.125 pixel spacing. This
suggests an additional effective raster scale, rather than bad input colours
or off-surface logical coordinates; it is not yet a proven platform cause.

The next diagnostic adds actual alpha-column band bounds to the existing
readback. In the isolated probe only, three fresh canvases use the same source
CSS/backing sizes and DPR transform, then paint a rectangle at logical
(10,12) with size 4 by 5. Its actual nontransparent backing bounds are compared
with the expected DPR-scaled bounds. One control is detached, one temporarily
offscreen under body, and one offscreen under the source canvas's parent to
share its ancestor compositing layer. Each attached control is removed in a
finally block. None paints into or over the product, and the original case
does not create controls or intercept native canvas methods.

Calibration run `38980106461` on `a89a6aa2d` confirms that the failed product
raster has the extra factor: grid alpha begins at backing y180 (logical20×9)
and its column bands are about195 pixels apart (logical21.708×9). The successful
third draw instead begins at y60 (logical20×3). All three fresh controls match
their expected 3× rectangle bounds even while the product is wrong, including
the control under the same source-parent ancestry. This narrows the defect to
the product surface's lifetime rather than a global readback-coordinate error.
The offscreen controls do not prove that every compositor path is equivalent.
Artifact `12080598299` is 450680 bytes, SHA256
`e72cdfb92ac2a921d88a32b0f17fed9ee6a0e4bbbaba3ae14c6a76752af9c912`.

The following product candidate acquires the 2D context before assigning any
changed backing dimensions. Those assignments therefore reset the initial
native graphics state before the explicit absolute DPR transform. Zero-size
hosts still return before acquiring a context, and unchanged dimensions still
preserve their bitmap. No DPR reduction, extra paint loop, geometry change or
test-threshold change is introduced. Exact Linux proof is required.

Context-order source `ab4be4aa3` passes all 40 local Chrome/WebKit tide-footer
cases, but Linux run `38980426704` retains the same grid alpha bands at y180
and about195 pixel spacing throughout the original case. Artifact
`12080472815` is 450687 bytes, SHA256
`d6a4f0ad4cd7df0b059dc1949a2b604143cd502048e806785735982ab5ae1781`.
Context acquisition order alone is therefore insufficient.

The next controlled product candidate removes only the graph wrapper's
identity `translateZ(0)` and its transform `will-change` hint. Layout/style
containment, dimensions, clipping, captions, DPR and draw scheduling remain
unchanged. This tests a hypothesis about the visible composited canvas surface;
the correct offscreen controls do not rule that path out. Diagnostics also
retain the graph wrapper's actual CSS rectangle/transform/will-change and
containment state. Original curve/axis/bounds/error guards remain mandatory.

Compositor source `af2494c7b` passed local 40/40 and the two-case Linux probe
`38980828931`, including the original case. The full exact-source focused run
`38981130780` nevertheless reproduces 15 original WebKit tide failures. Its
early layout artifact `12080383976` is 6213138 bytes, SHA256
`8de1e0f0b2f44e2459c7c64a35e8e2a77076292ce41d924b970bdf792ff4f014`.
Those have the same y180/grid-spacing195 native raster despite actual wrapper
transform none/will-change auto. The narrow probe pass did not establish a
complete repair, and the full release matrix remains ineligible.

The next candidate explicitly resets the context transform to identity before
setting the absolute DPR matrix, testing a stale native state-cache path while
retaining DPR3 and draw frequency. The isolated recorder counts that native
reset call as well. No unconditional repaint, pixel-threshold relaxation or
layout change is introduced. Full exact-source validation is still required.

Explicit-reset source `5ad163598` passed all 40 local Chrome/WebKit cases,
but full-order Linux run `38981976379` failed 16 cases, with 38 passing.
The original compact case and the separate probe retain grid-only pixels at
the same effective 9x scale despite the expected reported 3x transform and
three recorded explicit resets in the probe. Artifact `12081622491` is
6348723 bytes, SHA256
`3e67f74b9d12340497ab682b3595ce30ead01dd631d947d171162806a18b8800`.
The explicit reset therefore does not repair the full-order rendering defect.

The following controlled candidate requests `willReadFrequently: true` only
when acquiring the tide chart's 2D context. At the WebKit revision pinned by
Playwright 1.58.2, CanvasBase selects an unaccelerated image buffer for that
option; this tests a backend-specific surface-lifetime hypothesis. Backing
dimensions, DPR, paint count, geometry, all original pixel/layout guards and
the other application's canvas contexts stay unchanged. No readback or repaint
loop is added. Local proof and the complete exact-source Linux layout/graphics
suite remain required before acceptance.

Pinned upstream source:
https://raw.githubusercontent.com/WebKit/WebKit/486de399887bc8fa8a69e2f194ebc9476589a08a/Source/WebCore/html/CanvasBase.cpp
