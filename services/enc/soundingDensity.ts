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
/** Target density — roughly one sounding per this many pixels of glass.
 *  90 → 60 → 44 across Shane's on-water reads (2026-07-11: "a few more
 *  depth numbers", then "even more... the more the merrier") — now ~4×
 *  the original label count at every zoom. Mapbox collision culling +
 *  shallowest-first sort keep it readable; go below ~40 and the numbers
 *  start fighting the marks for glass. */
const CELL_PX = 44;
/** Ladder range: below MIN_Z even one number per 50 NM is clutter; past
 *  MAX_Z the chart is boat-length scale and every sounding may show. */
const MIN_Z = 4;
const MAX_Z = 16;

/**
 * Bakes a density min-zoom onto every sounding, combined with any
 * existing SCAMIN `_minZoom` via max (the stricter gate wins). Points
 * that never win a cell get MAX_Z + 1 — visible only past the ladder's
 * end. Mutates the features in place; the merged heap is throwaway.
 */
export function assignSoundingDensityMinZoom(features: Array<Feature<Point>>): void {
    const pts: Array<{ f: Feature<Point>; lon: number; lat: number; d: number }> = [];
    for (const f of features) {
        const c = f.geometry?.coordinates;
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
        const d = Number((f.properties as Record<string, unknown> | null)?._d);
        pts.push({ f, lon: c[0], lat: c[1], d: Number.isFinite(d) ? d : 9999 });
    }
    pts.sort((a, b) => a.d - b.d);

    const cellDeg: number[] = [];
    for (let z = 0; z <= MAX_Z; z++) cellDeg[z] = (CELL_PX * BASE_M_PER_PX) / 2 ** z / 111_320;

    // Packed numeric keys (~3× faster than template strings on a 170k
    // heap — this runs on-device at every cell-list merge). Cell index
    // range at z16 is ±~372k (19 bits + sign); pack as
    // z·2^44 + (x+2^21)·2^22 + (y+2^21), comfortably inside 2^53.
    const key = (z: number, lon: number, lat: number): number =>
        z * 2 ** 44 + (Math.floor(lon / cellDeg[z]) + 2 ** 21) * 2 ** 22 + (Math.floor(lat / cellDeg[z]) + 2 ** 21);

    const occupied = new Set<number>();
    for (const p of pts) {
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
        const prev = Number(props._minZoom);
        props._minZoom = Number.isFinite(prev) ? Math.max(prev, mz) : mz;
    }
}
