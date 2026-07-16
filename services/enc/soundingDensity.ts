/**
 * Sounding density ladder — deterministic "which depth numbers appear
 * at which zoom" (Shane 2026-07-11: zoomed out you want a number per
 * tens of NM; berthing you want one per boat length).
 *
 * Constant SCREEN density: one sounding per ~90 px grid cell at every
 * zoom, precomputed once per merge and baked as `_minZoom` — the same
 * gate SCAMIN uses, so the symbol layer needs no new plumbing and it
 * works offline. Shallowest-first assignment is a SAFETY invariant:
 * when one number must represent an area it is the scariest one — a
 * 0.9 m crest survives zoom-out while the friendly 18s around it drop
 * away. Mapbox's collision engine keeps whichever label it feels like;
 * this pass decides, deterministically.
 */
import type { Feature, Point } from 'geojson';

/** Metres per screen pixel at zoom 0 (Mapbox GL 512 px tiles, equator). */
const BASE_M_PER_PX = 78271.484;
/** Target density — roughly one sounding per this many pixels of glass,
 *  GRADUATED BY ZOOM (Shane 2026-07-11: "at zoom 14 we need a lot more
 *  depth numbers"): calm at bay scale where numbers are orientation,
 *  dense from ~z13 where you're threading a channel and every metre is
 *  a decision. 90 → 60 → 44 flat across earlier reads; now a curve. */
function cellPxAt(z: number): number {
    if (z <= 9) return 48;
    if (z <= 12) return 40;
    if (z === 13) return 34;
    if (z === 14) return 27;
    if (z === 15) return 22;
    return 18;
}
/** Ladder range: below MIN_Z even one number per 50 NM is clutter; past
 *  MAX_Z the chart is boat-length scale and every sounding may show. */
const MIN_Z = 4;
const MAX_Z = 16;

/**
 * Bound on the O(N·Z) rung-assignment probe (audit: this ran uncapped over a
 * ~170k heap on the main thread, before the LOD cull). Points are processed
 * SHALLOWEST-first, so the tail beyond this cap is always the DEEPEST — never
 * a grounding number — and in any realistic render window the MAX_Z grid is
 * already saturated by the shallower points, so the tail would resolve to
 * MAX_Z+1 anyway. Capping merely skips paying the per-point grid probe for
 * that tail; it NEVER drops a shallow (safety) sounding.
 */
const RUNG_ASSIGN_CAP = 80_000;

/**
 * Bakes a density min-zoom onto every sounding, REPLACING any SCAMIN
 * `_minZoom` the extractor pre-baked (SCAMIN pinned nearly every AU
 * sounding to z11+, which silenced the wide-zoom rungs entirely).
 * Points that never win a cell get MAX_Z + 1 — visible only past the
 * ladder's end. Mutates the features in place; the merged heap is
 * throwaway.
 *
 * SLICED (burn-down 2026-07-16): pass `yieldEvery` (the merge's cooperative
 * slicer) and the rung-assignment loop awaits it every 1024 points, so the
 * O(N·Z) pass no longer runs as ONE indivisible main-thread gulp on a big
 * heap. The occupancy grid is sequential state (shallowest-first invariant),
 * so slicing — not parallelising — is the correct decomposition. Without the
 * callback the pass is fully synchronous (tests, small heaps).
 */
export async function assignSoundingDensityMinZoom(
    features: Array<Feature<Point>>,
    yieldEvery?: () => Promise<void>,
): Promise<void> {
    const pts: Array<{ f: Feature<Point>; lon: number; lat: number; d: number }> = [];
    for (const f of features) {
        const c = f.geometry?.coordinates;
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
        const d = Number((f.properties as Record<string, unknown> | null)?._d);
        pts.push({ f, lon: c[0], lat: c[1], d: Number.isFinite(d) ? d : 9999 });
    }
    pts.sort((a, b) => a.d - b.d);

    const cellDeg: number[] = [];
    for (let z = 0; z <= MAX_Z; z++) cellDeg[z] = (cellPxAt(z) * BASE_M_PER_PX) / 2 ** z / 111_320;

    // Web-Mercator anisotropy: cellDeg is degrees-of-LONGITUDE per grid
    // cell (exact in screen space at every latitude), but a degree of
    // latitude spans 1/cos(lat) MORE pixels — one shared size made the
    // grid ~13% sparser vertically at 27°S and ~40% at Tasmania, so the
    // mid-zoom field read "column-y" instead of the even paper-chart
    // scatter (2026-07-12 audit). Latitude cells shrink by cos(lat),
    // sampled once at the merged set's mean latitude (a render window
    // spans a bay — the variation across it is sub-1%).
    const meanLat = pts.length > 0 ? pts.reduce((s, p) => s + p.lat, 0) / pts.length : 0;
    const cosLat = Math.max(Math.cos((meanLat * Math.PI) / 180), 0.2);
    const latCellDeg: number[] = [];
    for (let z = 0; z <= MAX_Z; z++) latCellDeg[z] = cellDeg[z] * cosLat;

    // Packed numeric keys (~3× faster than template strings on a 170k
    // heap — this runs on-device at every cell-list merge). Cell index
    // range at z16 is ±~372k (19 bits + sign); pack as
    // z·2^44 + (x+2^21)·2^22 + (y+2^21), comfortably inside 2^53.
    const key = (z: number, lon: number, lat: number): number =>
        z * 2 ** 44 + (Math.floor(lon / cellDeg[z]) + 2 ** 21) * 2 ** 22 + (Math.floor(lat / latCellDeg[z]) + 2 ** 21);

    const occupied = new Set<number>();
    for (let i = 0; i < pts.length; i++) {
        if (yieldEvery && (i & 1023) === 1023) await yieldEvery();
        const p = pts[i];
        // Deepest tail beyond the cap: skip the grid probe (it would resolve
        // to past-the-ladder against a saturated grid anyway). Safety-neutral —
        // shallowest-first sort means this is never a shoal number.
        if (i >= RUNG_ASSIGN_CAP) {
            ((p.f.properties ??= {}) as Record<string, unknown>)._minZoom = MAX_Z + 1;
            continue;
        }
        let mz = MAX_Z + 1;
        for (let z = MIN_Z; z <= MAX_Z; z++) {
            if (!occupied.has(key(z, p.lon, p.lat))) {
                mz = z;
                break;
            }
        }
        // Claim this point's cell at every zoom it will be visible at —
        // a sounding on screen consumes its patch of glass all the way in.
        for (let z = mz; z <= MAX_Z; z++) {
            occupied.add(key(z, p.lon, p.lat));
        }
        const props = (p.f.properties ??= {}) as Record<string, unknown>;
        // The ladder REPLACES the chart's SCAMIN pre-bake (was max() of
        // both): nearly every AU sounding carries SCAMIN ≈ z11+, so the
        // wide-zoom rungs never fired — a bay-scale view showed NO numbers
        // at all (Shane 2026-07-11: "can we start getting depths from
        // zoom 7??"). SCAMIN is paper-chart declutter advice; the
        // shallowest-wins ladder is a stricter, safety-biased declutter,
        // so overriding it widens visibility without adding clutter.
        props._minZoom = mz;
    }
}
