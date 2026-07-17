/**
 * mergeFold — the three concerns the ~520-line buildMergedVectorData closure
 * used to inline, carved into named, individually-readable units (ENC audit
 * 2026-07-19, finding #2 — the residual god-function):
 *
 *   - createClipGeometryMemos  (ring-assembly): per-cell clip geometry —
 *     shallow-band coverage polys, strip-rect masks, per-layer line extents —
 *     memoised for one merge run.
 *   - accumulateCellLayers     (layer-accumulation): the per-cell fold that
 *     tags + pushes every ENC layer's features into the merged shell.
 *   - applySoundingLod         (sounding-LOD): the density ladder + the
 *     look-ahead cull on the merged sounding heap.
 *
 * Every dependency arrives through explicit params / context — no module state
 * of its own — matching the glazeBuild.ts / geometryUpgrades.ts seam
 * discipline. Pure statement moves: the merge output is byte-identical (locked
 * by tests/enc/mergeFold.e2e.test.ts + the rest of tests/enc).
 */
import type { Feature, FeatureCollection, Point } from 'geojson';
import { assignSoundingDensityMinZoom } from './soundingDensity';
import {
    clipLineFeatureOutsideBboxes,
    coverageMaskStrips,
    type CoverageGeom,
    type FineCoverage,
} from './clipDepareOverlap';
import {
    cellScaleRank,
    featureBboxCached,
    featureIsShadowed,
    shadowingCells,
    GLAZE_SHADOW_RATIO,
    type CellExtent,
} from './scaleShadow';
import { buildCellGlaze } from './glazeBuild';
import { reduceNamedAreas } from './seaareLabels';
import { explodeSoundings } from './encHazardParse';
import { buildSectorFeatures, readSectorBearings } from './lightSectors';
import type { GlazeUpgradeItem } from './geometryUpgrades';
import {
    buildLightCharacterLabel,
    encNavaidIconId,
    ialaRegionForSourceHO,
    lateralMarkColour,
    lightColourHex,
    readS57,
    S57_POINT_MARK_CLASSES,
    CAUTION_AREA_CLASSES,
} from './types';
import type { EncCell, EncConversionResult } from './types';
import type { EncMergedVectorData } from './EncHazardService';

// ── ring-assembly: per-merge clip-geometry memoisers ──────────────────

/** The three clip-geometry memoisers a single merge run shares — each keyed
 *  by cell id (line extents by `cellId:layer`), all reading the run's loaded
 *  blobs. Coordinate arrays are shared with the cached blob, never cloned. */
export interface ClipGeometryMemos {
    /** Charted shallow-water footprint per SHADOWING cell — feeds the glaze's
     *  coverage subtraction. THREE states, load-bearing (2026-07-14, "large
     *  steps through the shipping channel" — conflating the last two blacked
     *  out whole corridor-cell extents):
     *    null              → blob unavailable: clip the whole data extent.
     *    []                → charted, but nothing shallow: clip NOTHING.
     *    polys (non-empty) → clip under strip-rasterised polys. */
    coverageFor: (cellId: string) => CoverageGeom | null;
    /** Strip-rect coverage per shadowing cell for the glaze clip (see
     *  coverageMaskStrips): the survey's REAL polygons rasterised into a
     *  staircase of rects that hugs the charted ribbon. Feature bboxes were
     *  tried first and failed — a channel cell's bands are long diagonal
     *  ribbons, so their bboxes blacked out the water beside the corridor
     *  (2026-07-14, "we still have these black squares"). */
    stripRectsFor: (cellId: string, extent: [number, number, number, number]) => [number, number, number, number][];
    /** Per-(cell, layer) LINE data extent for the seam de-dup (closing audit:
     *  the clip frame was the finer cell's whole DEPARE extent, so coarse
     *  contours vanished across water where the finer survey charts depth but
     *  carries NO contour lines there). */
    lineLayerExtent: (cellId: string, layer: 'DEPCNT' | 'COALNE') => [number, number, number, number] | null;
}

/**
 * ring-assembly: build the per-merge clip-geometry memoisers over a run's
 * loaded blobs. `shallowClip` is injected (it lives in EncHazardService, whose
 * own test imports it) so this module stays a cycle-free leaf. Every memo is
 * scoped to the returned object — no module state — so a run's caches die with
 * it.
 */
export function createClipGeometryMemos(
    loadedBlobs: Map<string, EncConversionResult>,
    shallowClip: (collections: Array<FeatureCollection | undefined>) => CoverageGeom,
): ClipGeometryMemos {
    // Charted-water footprint per SHADOWING cell, memoized for this run.
    const coverageMemo = new Map<string, CoverageGeom | null>();
    const coverageFor = (cellId: string): CoverageGeom | null => {
        const memo = coverageMemo.get(cellId);
        if (memo !== undefined) return memo;
        const b = loadedBlobs.get(cellId);
        const cov = b ? shallowClip([b.layers.DEPARE, b.layers.DRGARE]) : null;
        coverageMemo.set(cellId, cov);
        return cov;
    };

    // Strip-rect coverage per shadowing cell for the glaze clip. Memoized per
    // merge run — the same cell shadows many coarse cells.
    const stripRectsMemo = new Map<string, [number, number, number, number][]>();
    const stripRectsFor = (cellId: string, extent: [number, number, number, number]) => {
        const memo = stripRectsMemo.get(cellId);
        if (memo) return memo;
        const cov = coverageFor(cellId);
        // k=40: shallow-band-only coverage (see coverageFor) leaves far
        // fewer inside-nodes, so a finer grid stays ~1 ms with the ring-
        // bbox prefilter while halving the quantisation halo around banks.
        // NOTE: coverageMaskStrips falls back to [extent] on EMPTY input,
        // so the nothing-shallow case must short-circuit to [] here.
        const rects = cov == null ? [extent] : cov.length === 0 ? [] : coverageMaskStrips(cov, extent, 40, 160);
        stripRectsMemo.set(cellId, rects);
        return rects;
    };

    // Per-(cell, layer) LINE data extents for the seam de-dup. Memoized per run.
    const lineExtentMemo = new Map<string, [number, number, number, number] | null>();
    const lineLayerExtent = (cellId: string, layer: 'DEPCNT' | 'COALNE'): [number, number, number, number] | null => {
        const key = `${cellId}:${layer}`;
        const hit = lineExtentMemo.get(key);
        if (hit !== undefined) return hit;
        let mx = Infinity,
            my = Infinity,
            Mx = -Infinity,
            My = -Infinity;
        for (const f of loadedBlobs.get(cellId)?.layers[layer]?.features ?? []) {
            const bb = featureBboxCached(f);
            if (!bb) continue;
            if (bb[0] < mx) mx = bb[0];
            if (bb[1] < my) my = bb[1];
            if (bb[2] > Mx) Mx = bb[2];
            if (bb[3] > My) My = bb[3];
        }
        const out: [number, number, number, number] | null = Number.isFinite(mx) ? [mx, my, Mx, My] : null;
        lineExtentMemo.set(key, out);
        return out;
    };

    return { coverageFor, stripRectsFor, lineLayerExtent };
}

// ── layer-accumulation: the per-cell fold ─────────────────────────────

/** Geometry classes eligible for the wide-zoom sub-pixel cull. Point
 *  layers (marks, lights, hazards) are NEVER culled — a point has zero
 *  extent but full meaning. */
const SUBPIXEL_CULLABLE = new Set(['DEPARE', 'LNDARE', 'COALNE', 'DEPCNT']);

/** Area classes whose coarse polygons are dropped when fully inside a much-
 *  finer cell's charted ground (the finer cell owns it); point marks untouched. */
const SHADOWED_CLASSES = new Set(['LNDARE', 'DEPARE', 'COALNE', 'DEPCNT']);

/** Light sectors stay ON — generation is O(sectored-lights), cheap, and
 *  it's the flagship night-approach feature. Flag exists so it can be
 *  killed instantly if it ever proves otherwise. */
const LIGHT_SECTORS_ENABLED = true;

/** Bbox diagonal of a polygon/line feature in degrees; Infinity for
 *  point/other geometry so the sub-pixel cull can never touch it. Shares the
 *  memoized featureBboxCached walk with the scale-shadow test (audit rank 6:
 *  this used to be a second identical full-coordinate walk of the same
 *  feature every merge). */
function featureDiagDeg(feat: Feature): number {
    const g = feat.geometry;
    if (
        !g ||
        (g.type !== 'Polygon' && g.type !== 'MultiPolygon' && g.type !== 'LineString' && g.type !== 'MultiLineString')
    ) {
        return Infinity;
    }
    const bb = featureBboxCached(feat);
    if (!bb) return Infinity;
    return Math.hypot(bb[2] - bb[0], bb[3] - bb[1]);
}

/** Everything one cell's fold reads or mutates. All accumulators (`merged`,
 *  `seaareByName`, the glaze bookkeeping) are shared across the whole merge
 *  run and mutated in place — same seam discipline as glazeBuild.ts. */
export interface CellAccumulationContext {
    merged: EncMergedVectorData;
    /** Every cell's registry bbox — the scale-shadow candidate set. */
    cellExtents: CellExtent[];
    /** Per-cell DEPARE/DRGARE DATA extent (the ground each cell actually
     *  charts) — shadow lists are re-anchored on this, not the registry bbox. */
    depareExtent: Map<string, [number, number, number, number]>;
    coverageFor: ClipGeometryMemos['coverageFor'];
    stripRectsFor: ClipGeometryMemos['stripRectsFor'];
    lineLayerExtent: ClipGeometryMemos['lineLayerExtent'];
    /** Finest-cell-wins accumulator of named-area label points. */
    seaareByName: Map<string, Feature>;
    /** The job's shared coverage library the glaze upgrade queue references. */
    glazeCoverageLib: Map<string, FineCoverage>;
    glazeUpgradeQueue: GlazeUpgradeItem[];
    mergeGlazeKeys: string[];
    /** Build the satellite keel-glaze this run (zoom ≥ GLAZE_MIN_ZOOM). */
    buildGlaze: boolean;
    /** Sub-pixel cull threshold in degrees; 0 on the full merge (cull off). */
    cullDeg: number;
    yieldIfNeeded: () => Promise<void>;
}

/**
 * layer-accumulation: fold ONE cell's blob into the merged shell — tag every
 * layer's features with provenance, drop scale-shadowed area geometry, de-dup
 * partially-overlapping coarse contour/coast lines, pre-bake mark/light render
 * props, build the glaze variant, reduce named areas, and explode soundings.
 * Called once per cell in COARSE→FINE order (finest paints last). All state is
 * mutated through `ctx`; the per-cell locals are recomputed each call.
 */
export async function accumulateCellLayers(
    cell: EncCell,
    blob: EncConversionResult,
    ctx: CellAccumulationContext,
): Promise<void> {
    const {
        merged,
        cellExtents,
        depareExtent,
        coverageFor,
        stripRectsFor,
        lineLayerExtent,
        seaareByName,
        glazeCoverageLib,
        glazeUpgradeQueue,
        mergeGlazeKeys,
        buildGlaze,
        cullDeg,
        yieldIfNeeded,
    } = ctx;

    await yieldIfNeeded(); // per-cell clone/clip/explode is the heavy loop
    merged.cellCount++;

    const ialaRegion = ialaRegionForSourceHO(cell.sourceHO);
    // Shadow lists re-anchored on DATA extents: a finer cell with no
    // DEPARE (marks-only) never erases coarse bands at all.
    const reanchorOnDepare = (list: readonly CellExtent[]) =>
        list
            .map((s) => (depareExtent.has(s.id) ? { id: s.id, bbox: depareExtent.get(s.id)! } : null))
            .filter((s): s is { id: string; bbox: [number, number, number, number] } => s !== null);
    const shadows = reanchorOnDepare(shadowingCells({ id: cell.id, bbox: cell.bbox }, cellExtents));
    // Gap-safe LINE de-dup rects (audit ×2: coarse DEPCNT/COALNE
    // double-painted across finer surveys while the tested
    // clipLineFeatureOutsideBboxes sat unwired). The naive whole-shadow
    // clip is what punched coastline holes historically — a ribbon cell
    // (e.g. OC-61-20ENB5) charts DEPARE but carries NO coastline, so
    // clipping against ITS extent erased the coast. Presence-gate: only
    // finer cells that actually CARRY the same line layer get to clip it.
    const lineDedupRects = (layer: 'DEPCNT' | 'COALNE'): [number, number, number, number][] =>
        shadows
            .map((s) => lineLayerExtent(s.id, layer))
            .filter((e): e is [number, number, number, number] => e !== null);
    const depcntDedupRects = shadows.length > 0 ? lineDedupRects('DEPCNT') : [];
    const coalneDedupRects = shadows.length > 0 ? lineDedupRects('COALNE') : [];
    // The GLAZE clips against every meaningfully-finer overlapping
    // cell, not just the ≥16x ones (adversarial review 2026-07-14:
    // adjacent-band pairs inside 16x left coarse SAFE-white painting
    // over water the finer survey charts as under-keel — see
    // GLAZE_SHADOW_RATIO). Superset of `shadows`; the base-feature
    // DROP above stays at the destructive-safe 16x.
    const glazeShadows = buildGlaze
        ? reanchorOnDepare(shadowingCells({ id: cell.id, bbox: cell.bbox }, cellExtents, GLAZE_SHADOW_RATIO))
        : [];

    const tagAndPush = async (
        target: keyof Omit<EncMergedVectorData, 'cellCount'>,
        fc: FeatureCollection | undefined,
    ): Promise<void> => {
        if (!fc || !Array.isArray(fc.features)) return;
        const dest = merged[target];
        // PER-FEATURE-BATCH yielding (burn-down: the fold ran each dense
        // cell in one synchronous gulp — the only yield was per-CELL, so
        // a 10k-feature harbour cell blew the 12 ms slice on its own).
        let processed = 0;
        for (const feat of fc.features) {
            if ((++processed & 63) === 0) await yieldIfNeeded();
            if (!feat || !feat.geometry) continue;
            // Sub-pixel cull (2026-07-13, the z7-8 OOM): at passage zoom
            // a shoal patch / islet / contour scrap smaller than ~2 px
            // cannot be seen, but still costs worker tiling + GPU
            // buffers — and a 47-cell wide window carries thousands of
            // them. cullDeg is 0 only on the full merge.
            if (cullDeg > 0 && SUBPIXEL_CULLABLE.has(target) && featureDiagDeg(feat) < cullDeg) continue;
            if (shadows.length > 0 && SHADOWED_CLASSES.has(target) && featureIsShadowed(feat, shadows)) continue;
            // LINE de-dup for partially-overlapping coarse contour/coast
            // lines (fully-shadowed ones were dropped above): trim the
            // parts inside a finer survey that charts the SAME layer, so
            // seams stop double-drawing at 0.95+ opacity. Presence-gated
            // rects (above) keep the ribbon-cell "coastline holes" failure
            // out; a null clip = the line lives entirely under finer data.
            let outGeometry = feat.geometry;
            if (target === 'DEPCNT' || target === 'COALNE') {
                const rects = target === 'DEPCNT' ? depcntDedupRects : coalneDedupRects;
                if (rects.length > 0) {
                    const clipped = clipLineFeatureOutsideBboxes(feat, rects);
                    // Yield EVERY clipped line feature, not on the 64-stride
                    // above: per-feature clipLineFeatureOutsideBboxes on
                    // multi-thousand-vertex contours/coastlines let 300 ms+
                    // run uninterrupted between yields (closing audit
                    // 2026-07-18 — the glazeBuild fold already learned this).
                    // yieldIfNeeded is time-gated (12 ms) so it's cheap.
                    await yieldIfNeeded();
                    if (!clipped) continue;
                    outGeometry = clipped.geometry;
                }
            }
            // GEOMETRY CLIPPING RETIRED (2026-07-11, same day it
            // shipped): cutting coarse DEPARE out of a finer cell's
            // data-extent RECTANGLE left bare black holes wherever the
            // fine cell charts only part of that rectangle (Shane:
            // "the horrible black lines are back" — black boxes over
            // the Bribie channel). In the chart-first world the fills
            // are near-opaque and the merge is sorted coarse→fine, so
            // finest-paints-last hides overlaps WITHOUT cutting holes.
            // (The satellite GLAZE can re-stack translucently — it's a
            // manual peek now; a proper coverage-geometry clip is the
            // future fix if that ever grates. clipDepareOverlap.ts
            // stays for that day.)
            // Decorate properties with provenance so the map
            // can keep "which cell" context for clicks/etc.
            const props: Record<string, unknown> = {
                ...(feat.properties ?? {}),
                _cellId: cell.id,
                _sourceHO: cell.sourceHO,
                _ialaRegion: ialaRegion,
            };
            // Fineness rank rides along on DEPARE so the renderer can
            // retire a coarse cell's bands at zooms beyond its survey's
            // competence (the "1980s edges", 2026-07-11). Set on the new
            // props object — never stamped into the cached blob here.
            if (target === 'DEPARE') props._scaleRank = cellScaleRank(cell.bbox);

            // Pre-compute the display colour for lateral marks
            // (BOYLAT/BCNLAT) so the renderer doesn't need a
            // case expression that knows about IALA regions.
            // Cardinal marks (BOYCAR/BCNCAR) are always yellow.
            if (target === 'BOYLAT' || target === 'BCNLAT') {
                const catlamRaw = readS57(feat.properties, 'CATLAM') as unknown;
                const catlam = typeof catlamRaw === 'number' ? catlamRaw : Number(catlamRaw);
                props._displayColor = lateralMarkColour(Number.isFinite(catlam) ? catlam : null, ialaRegion);
            }

            // Pre-bake the IALA symbol id + collision priority so
            // the renderer's symbol layers stay dumb expressions.
            // Cardinals mark danger → lowest sort key (wins
            // collision placement), laterals next, specials last.
            if (
                target === 'BOYLAT' ||
                target === 'BCNLAT' ||
                target === 'BOYCAR' ||
                target === 'BCNCAR' ||
                target === 'BOYSPP' ||
                target === 'BCNSPP' ||
                target === 'BOYSAW' ||
                target === 'BCNSAW' ||
                target === 'BOYISD' ||
                target === 'BCNISD'
            ) {
                const featProps = (feat.properties ?? {}) as Record<string, unknown>;
                props._icon = encNavaidIconId(target, featProps, ialaRegion);
                // Danger marks (cardinals + isolated danger) win the
                // collision engine, then laterals + safe water, then
                // specials.
                props._priority =
                    target === 'BOYCAR' || target === 'BCNCAR' || target === 'BOYISD' || target === 'BCNISD'
                        ? 0
                        : target === 'BOYSPP' || target === 'BCNSPP'
                          ? 2
                          : 1;
            }

            // Lights: pre-bake everything the renderer + label
            // layers need so paint expressions stay coalesces.
            //  - _lightTier: VALNMR >= 10 NM = 'major' (always
            //    shown); missing VALNMR defaults minor (correct
            //    bias — only 26/400 live lights carry VALNMR).
            //  - _lightColor: first code of the comma-split
            //    S-57 COLOUR string → display hex.
            //  - _lightLabel: 'Fl(2)G 5s 12m 8M' character
            //    string, omitted when LITCHR is absent.
            if (target === 'LIGHTS') {
                const featProps = (feat.properties ?? {}) as Record<string, unknown>;
                const valnmr = Number(readS57(featProps, 'VALNMR'));
                // TIERING beyond VALNMR (closing audit: only 26/400 live
                // lights carry VALNMR, so 'nearly every light hid below
                // z10'). Major = long range OR a light that is sectored /
                // carries a full character (real navigation lights);
                // bare minor deck lights stay minor.
                const sectored = readS57(featProps, 'SECTR1') != null;
                const hasCharacter = readS57(featProps, 'LITCHR') != null && readS57(featProps, 'SIGPER') != null;
                props._lightTier =
                    (Number.isFinite(valnmr) && valnmr >= 10) || sectored || hasCharacter ? 'major' : 'minor';
                if (Number.isFinite(valnmr) && valnmr > 0) props._valnmr = valnmr;
                const colHex = lightColourHex(readS57(featProps, 'COLOUR'));
                if (colHex) props._lightColor = colHex;
                const label = buildLightCharacterLabel(featProps);
                if (label) props._lightLabel = label;
                // Sectored light → generate the coloured arc + limit
                // legs into LIGHTSEC (night-approach read). Each S-57
                // sector is its own LIGHTS feature, so this fires per
                // sector and one light's sectors accrete naturally.
                const bearings = LIGHT_SECTORS_ENABLED ? readSectorBearings(featProps) : null;
                if (bearings && feat.geometry?.type === 'Point') {
                    const secProps = {
                        _cellId: cell.id,
                        _minZoom: typeof props._minZoom === 'number' ? props._minZoom : undefined,
                        OBJNAM: readS57(featProps, 'OBJNAM'),
                        _lightLabel: label ?? undefined,
                        // For the tap-to-read sector popup (#3a): name the
                        // colour and the from-seaward limit bearings a
                        // helmsman reads off the water (raw, NOT the +180
                        // reciprocal the arc is DRAWN on).
                        COLOUR: readS57(featProps, 'COLOUR'),
                        SECTR1: bearings.sectr1,
                        SECTR2: bearings.sectr2,
                    };
                    merged.LIGHTSEC.features.push(
                        ...buildSectorFeatures({
                            position: feat.geometry.coordinates as [number, number],
                            valnmr: readS57(featProps, 'VALNMR'),
                            sectr1: bearings.sectr1,
                            sectr2: bearings.sectr2,
                            colorHex: colHex ?? '#f0e030',
                            baseProps: secProps,
                        }),
                    );
                }
            }

            dest.features.push({ ...feat, geometry: outGeometry, properties: props });
        }
    };

    await tagAndPush('DEPARE', blob.layers.DEPARE);
    // DRGARE (dredged areas) carries DRVAL1 just like DEPARE —
    // merge into the same collection so dredged basins shade
    // with the draft-aware depth bands instead of rendering as
    // chart holes.
    await tagAndPush('DEPARE', blob.layers.DRGARE);
    // Glaze variant — built from the ORIGINAL band features (NOT the
    // post-featureIsShadowed survivors). Two grades:
    //  - INSTANT (here, main thread): finer cells' data-extent
    //    RECTANGLES subtracted (Sutherland–Hodgman, microseconds).
    //    May leave surf-strip dark boxes where a fine survey charts
    //    only part of its rectangle.
    //  - UPGRADED (encGeometryWorker): the finer cells' ACTUAL charted
    //    coverage subtracted (martinez) — exactly one band over
    //    charted water, zero holes ("shaded areas around some areas
    //    in shore", Shane 2026-07-12). Swapped in via the geometry-
    //    upgrade hook when the worker answers; NEVER computed here
    //    (it OOM-killed the WebView, device log 2026-07-13).
    // ZOOM-GATED to nav zoom — a second copy of every band across a
    // passage-zoom window fed the z7-8 OOM. See GLAZE_MIN_ZOOM.
    if (buildGlaze) {
        await buildCellGlaze({
            cell,
            blob,
            glazeShadows,
            coverageFor,
            stripRectsFor,
            glazeCoverageLib,
            glazeUpgradeQueue,
            merged,
            mergeGlazeKeys,
            yieldIfNeeded,
        });
    }
    await tagAndPush('LNDARE', blob.layers.LNDARE);
    await tagAndPush('COALNE', blob.layers.COALNE);
    await tagAndPush('DEPCNT', blob.layers.DEPCNT);
    // Every S-57 point-mark class, driven by the canonical registry
    // (#2a full bind) — a class added there can't be silently forgotten
    // here (order across these distinct collections is immaterial).
    for (const cls of S57_POINT_MARK_CLASSES) await tagAndPush(cls, blob.layers[cls]);
    await tagAndPush('RECTRC', blob.layers.RECTRC);
    // Fairway boundaries — extracted since Phase 6 for routing preference
    // but never DRAWN (burn-down: "render the already-extracted FAIRWY").
    await tagAndPush('FAIRWY', blob.layers.FAIRWY);

    // Caution / info AREAS → one CAUTION_AREAS collection, each feature
    // tagged `_caution` with its S-57 class so the renderer styles
    // restricted / cable / pipeline / seabed / TSS apart (2026-07-16
    // audit). Same provenance + sub-pixel cull as the other area classes.
    for (const cls of CAUTION_AREA_CLASSES) {
        const fc = blob.layers[cls];
        if (!fc || !Array.isArray(fc.features)) continue;
        for (const feat of fc.features) {
            if (!feat || !feat.geometry) continue;
            if (cullDeg > 0 && featureDiagDeg(feat) < cullDeg) continue;
            merged.CAUTION_AREAS.features.push({
                type: 'Feature',
                geometry: feat.geometry,
                properties: {
                    ...(feat.properties ?? {}),
                    _caution: cls,
                    _cellId: cell.id,
                    _sourceHO: cell.sourceHO,
                },
            });
        }
    }

    // Named areas → ONE label point per name ("put the channel
    // name in the channels", Shane 2026-07-13; "more names, like
    // names of islands", 2026-07-14). Skips tagAndPush: the
    // polygons are label carriers only — reducing them here keeps a
    // bay-sized SEAARE from ever entering the render heap. Label
    // anchor = outer-ring vertex average of the largest polygon (a
    // curving river's centroid can drift slightly off-axis; readable,
    // and the finest chart's tighter geometry wins the dedupe).
    // The AU SENC emits most named areas as POINTS — the
    // cartographer's own label anchor, use it verbatim.
    // Named areas → ONE label point per name (SEAARE waterways + named
    // LNDARE islands — LNDARE already carries OBJNAM on named land, no
    // LNDRGN extraction needed). Extracted to seaareLabels.ts (pure +
    // tested); finest-cell-wins via the shared seaareByName accumulator.
    reduceNamedAreas(blob.layers.SEAARE, 'water', seaareByName);
    reduceNamedAreas(blob.layers.LNDARE, 'land', seaareByName);

    // Soundings: explode each MultiPoint cloud into labelled points via
    // the pure explodeSoundings (no provenance — the minimal {_d,_minZoom}
    // bag keeps the merged heap sane). Pushed one at a time (a harbour
    // cell's thousands of points would overflow a spread-arg push).
    for (const p of explodeSoundings(blob.layers.SOUNDG)) merged.SOUNDG.features.push(p);
}

// ── sounding-LOD: density ladder + look-ahead cull ────────────────────

/** Keep soundings whose density-ladder `_minZoom` is within this many
 *  levels of the current zoom; the rest can't render yet and only bloat
 *  the (very expensive) symbol source. A whole-zoom re-merge refreshes
 *  the set, so the look-ahead just needs to cover one hook re-merge step. */
const SOUNDING_LOD_LOOKAHEAD = 2;

/**
 * Sounding-LOD finalise on the MERGED sounding heap (never per cell — a
 * per-cell pass doubles density at every cell seam):
 *
 *  1. Bake "one number per ~90 px of glass" min-zooms onto the heap,
 *     shallowest-first (safety: the surviving number is always the scariest
 *     nearby). The ladder slices itself through the merge's cooperative
 *     yielder every 1024 points, and is CAPPED to the rungs this window can
 *     render (the cull below discards `_minZoom > zoom + LOOKAHEAD`).
 *  2. Drop the soundings that can't render within LOOKAHEAD of the current
 *     zoom (the z7-8 OOM, 2026-07-13): a wide-window merge holds ~30 k of
 *     them but SCAMIN hides all but a handful at passage scale — yet every
 *     one still loads into the source as a collision-tested text symbol, the
 *     single heaviest layer on the map. `zoom == null` (seaway/full merge)
 *     keeps them all.
 */
export async function applySoundingLod(
    merged: EncMergedVectorData,
    zoom: number | undefined,
    yieldIfNeeded: () => Promise<void>,
): Promise<void> {
    await assignSoundingDensityMinZoom(
        merged.SOUNDG.features as Array<Feature<Point>>,
        yieldIfNeeded,
        zoom != null ? Math.round(zoom) + SOUNDING_LOD_LOOKAHEAD : undefined,
    );

    if (zoom != null) {
        const cap = zoom + SOUNDING_LOD_LOOKAHEAD;
        merged.SOUNDG.features = merged.SOUNDG.features.filter((f) => {
            const mz = (f.properties as { _minZoom?: number } | null)?._minZoom;
            return typeof mz !== 'number' || mz <= cap;
        });
    }
}
