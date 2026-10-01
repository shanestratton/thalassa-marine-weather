/**
 * The offline water pack's tiles (Phase 2b, 2026-10-01). Pure: no I/O.
 *
 * Owner decision 2: the Newport canal gets no route offline UNTIL the offline
 * water pack — the charts paint the canal estate as land, and only the OSM
 * overlay (canal lines, marina basins, OSM water) carries it. The pack keeps
 * every overlay the phone downloads, cut into 0.05° squares, so a passage
 * planned online can be routed again with no signal.
 *
 * A tile is a 0.05° square keyed by integer index, `${floor(lon*20)}_${floor
 * (lat*20)}` — 20 per degree (measured on the repo fixtures: 1.6× feature
 * duplication against 2× at 0.025°; at 0.1° only 3 whole tiles fitted a
 * Newport → Pinkenba corridor). It holds WHOLE, unclipped OSM features from
 * the nine overlay classes: clipping could manufacture water edges and break
 * lead endpoints. A feature crossing a tile edge is stored in every tile it
 * touches, and assembly dedupes by class + _osmId + the feature's own extent,
 * because a multipolygon's outers share one _osmId (newport-pinkenba-osm has
 * one; deduping by id alone would silently drop water).
 *
 * The safety rule: features that ENABLE routing (water, marina, canal lines,
 * leading lines) are used only where every tile they touch inside the route's
 * bbox is present — the pack never adds water where it cannot also vouch for
 * the obstacles (reef, breakwater, aeroway, berths, coastline), which are
 * always used. A missing tile degrades to today's chart-only routing, never
 * to unsafe water.
 *
 * Fix-up (2026-10-02): a tile saved later that should hold an enabling
 * feature and does not has superseded it — a basin reclaimed since is not
 * routed on because its older neighbour still holds it. Assembly also says
 * which enabling features it left out for a missing tile (unsavedWater), so
 * a route can say why it found no water there; and an online answer is
 * fetched on the tile grid (tileAlignedFetchBbox), so every tile a route
 * touches is saved whole.
 */
import type { Feature, FeatureCollection } from 'geojson';

export type Bbox = [number, number, number, number];

/** 0.05° tiles: 20 per degree. A later size is a new store directory. */
export const WATER_PACK_TILES_PER_DEG = 20;

/** The overlay classes, in the overlay's own order. */
export const OVERLAY_CLASSES = [
    'water',
    'reef',
    'coastline',
    'marina',
    'breakwater',
    'aeroway',
    'canalLines',
    'navLines',
    'berths',
] as const;
export type OverlayClass = (typeof OVERLAY_CLASSES)[number];

/** Classes that open water to the router — used only where the pack is whole. */
export const ENABLING_CLASSES: ReadonlySet<OverlayClass> = new Set<OverlayClass>([
    'water',
    'marina',
    'canalLines',
    'navLines',
]);

export type PackOverlay = Record<OverlayClass, FeatureCollection>;

/** How far round an endpoint its own water must be saved (~1.1 km). */
export const ENDPOINT_AREA_DEG = 0.01;
/** The fetched bbox is shrunk by this before whole tiles are taken from it:
 *  it absorbs the pre-2b Pi's rounded cache key, whose reply could fall up to
 *  0.005° short at an edge. */
export const FETCH_MARGIN_DEG = 0.01;

const EPS = 1e-9;
const N = WATER_PACK_TILES_PER_DEG;

export function emptyPackOverlay(): PackOverlay {
    const o = {} as PackOverlay;
    for (const k of OVERLAY_CLASSES) o[k] = { type: 'FeatureCollection', features: [] };
    return o;
}

export function overlayIsAllEmpty(overlay: Partial<Record<OverlayClass, FeatureCollection | undefined>>): boolean {
    return OVERLAY_CLASSES.every((k) => (overlay[k]?.features?.length ?? 0) === 0);
}

const validBbox = ([w, s, e, n]: Bbox): boolean =>
    [w, s, e, n].every(Number.isFinite) && w < e && s < n && w >= -180 && e <= 180 && s >= -90 && n <= 90;

const key = (x: number, y: number): string => `${x}_${y}`;

export function tileKeyFor(p: { lat: number; lon: number }): string {
    return key(Math.floor(p.lon * N + EPS), Math.floor(p.lat * N + EPS));
}

export function tileBounds(tileKey: string): Bbox {
    const [x, y] = tileKey.split('_').map(Number);
    return [x / N, y / N, (x + 1) / N, (y + 1) / N];
}

/** Tile index ranges touching the bbox's interior (an edge it only meets is
 *  not touched). Empty for an antimeridian (W > E) or invalid bbox. */
function touchedRange(bbox: Bbox): { x0: number; x1: number; y0: number; y1: number } | null {
    if (!validBbox(bbox)) return null;
    const [w, s, e, n] = bbox;
    return {
        x0: Math.floor(w * N + EPS),
        x1: Math.ceil(e * N - EPS) - 1,
        y0: Math.floor(s * N + EPS),
        y1: Math.ceil(n * N - EPS) - 1,
    };
}

export function tileKeysForBbox(bbox: Bbox): string[] {
    const r = touchedRange(bbox);
    if (!r) return [];
    const out: string[] = [];
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push(key(x, y));
    return out;
}

/**
 * The bbox to fetch so that every tile `bbox` touches is saved whole: its
 * tiles' outer edges plus the fill's margin (2026-10-02). A route's own bbox
 * is never tile-aligned — fetched as it was, only the tiles wholly inside it
 * could be saved (14 of newport-shane's 54), and the water reaching the rest
 * was dropped when the passage was routed again offline. Unchanged for an
 * antimeridian or invalid bbox.
 */
export function tileAlignedFetchBbox(bbox: Bbox, marginDeg = FETCH_MARGIN_DEG): Bbox {
    const r = touchedRange(bbox);
    if (!r) return bbox;
    const round = (v: number): number => Number(v.toFixed(6));
    return [
        Math.max(-180, round(r.x0 / N - marginDeg)),
        Math.max(-90, round(r.y0 / N - marginDeg)),
        Math.min(180, round((r.x1 + 1) / N + marginDeg)),
        Math.min(90, round((r.y1 + 1) / N + marginDeg)),
    ];
}

/** Tiles wholly inside a fetched bbox shrunk by the margin: only these can be
 *  saved from a reply, since a tile half outside it may be missing features. */
export function tileKeysFullyInside(fetched: Bbox, marginDeg = FETCH_MARGIN_DEG): string[] {
    if (!validBbox(fetched)) return [];
    const [w, s, e, n] = fetched;
    const x0 = Math.ceil((w + marginDeg) * N - EPS);
    const x1 = Math.floor((e - marginDeg) * N + EPS) - 1;
    const y0 = Math.ceil((s + marginDeg) * N - EPS);
    const y1 = Math.floor((n - marginDeg) * N + EPS) - 1;
    const out: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(key(x, y));
    return out;
}

/** The tiles that must be saved for an endpoint's own water: ±0.01° round it. */
export function endpointAreaKeys(p: { lat: number; lon: number }, deg = ENDPOINT_AREA_DEG): string[] {
    return tileKeysForBbox([p.lon - deg, p.lat - deg, p.lon + deg, p.lat + deg]);
}

/** A feature's extent from its geometry; f.bbox is never trusted. */
export function featureBbox(f: Feature): Bbox | null {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            const lon = c[0] as number;
            const lat = c[1] as number;
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            if (lon < w) w = lon;
            if (lon > e) e = lon;
            if (lat < s) s = lat;
            if (lat > n) n = lat;
            return;
        }
        for (const x of c) walk(x);
    };
    const visit = (g: unknown): void => {
        if (!g || typeof g !== 'object') return;
        const geom = g as { type?: string; coordinates?: unknown; geometries?: unknown[] };
        if (geom.type === 'GeometryCollection') for (const x of geom.geometries ?? []) visit(x);
        else walk(geom.coordinates);
    };
    visit(f?.geometry);
    return Number.isFinite(w) ? [w, s, e, n] : null;
}

function coordinateCount(f: Feature): number {
    let count = 0;
    const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') {
            count++;
            return;
        }
        for (const x of c) walk(x);
    };
    walk((f?.geometry as { coordinates?: unknown } | null)?.coordinates);
    return count;
}

/**
 * A feature's identity across tiles: class, OSM id, geometry type, vertex
 * count and extent to 1e-7°. The extent is what tells a multipolygon's outers
 * apart (they share an _osmId); the rest keeps two id-less features that
 * happen to share an extent from collapsing into one.
 */
export function featureKey(cls: OverlayClass, f: Feature): string {
    const id = (f?.properties as { _osmId?: unknown } | null)?._osmId;
    const b = featureBbox(f);
    return `${cls}|${id ?? 'x'}|${f?.geometry?.type ?? '?'}|${coordinateCount(f)}|${b ? b.map((v) => v.toFixed(7)).join(',') : '-'}`;
}

const intersects = (a: Bbox, b: Bbox): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * The features of an overlay whose extent meets `bbox` — what an online
 * answer fetched on the tile grid gives the router for its own bbox, the same
 * set assembleFromTiles gives back from the saved tiles (2026-10-02).
 */
export function overlayWithin<T extends Partial<PackOverlay>>(overlay: T, bbox: Bbox): T {
    const out = { ...overlay };
    for (const cls of OVERLAY_CLASSES) {
        const fc = overlay[cls];
        if (!fc?.features) continue;
        out[cls] = {
            ...fc,
            features: fc.features.filter((f) => {
                const b = featureBbox(f);
                return !!b && intersects(b, bbox);
            }),
        } as T[typeof cls];
    }
    return out;
}

/**
 * Cut a COMPLETE overlay of `fetchedBbox` into tiles: only the tiles wholly
 * inside it (tileKeysFullyInside), each with every whole feature whose extent
 * touches the tile (edges inclusive). A tile with no feature is still a tile —
 * an empty one says "nothing mapped here", which is not "not saved". Features
 * are sorted by key inside each class so the same content always serialises,
 * and signs, the same.
 */
export function splitOverlayIntoTiles(overlay: Partial<PackOverlay>, fetchedBbox: Bbox): Map<string, PackOverlay> {
    const tiles = new Map<string, PackOverlay>();
    for (const k of tileKeysFullyInside(fetchedBbox)) tiles.set(k, emptyPackOverlay());
    if (tiles.size === 0) return tiles;
    const keyed = new Map<string, { cls: OverlayClass; f: Feature; key: string }[]>();
    for (const cls of OVERLAY_CLASSES) {
        for (const f of overlay[cls]?.features ?? []) {
            const b = featureBbox(f);
            if (!b) continue;
            const x0 = Math.floor(b[0] * N + EPS);
            const x1 = Math.floor(b[2] * N + EPS);
            const y0 = Math.floor(b[1] * N + EPS);
            const y1 = Math.floor(b[3] * N + EPS);
            // An edge exactly on a tile line also touches the tile before it.
            const xs = Math.abs(b[0] * N - Math.round(b[0] * N)) < 1e-7 ? Math.round(b[0] * N) - 1 : x0;
            const ys = Math.abs(b[1] * N - Math.round(b[1] * N)) < 1e-7 ? Math.round(b[1] * N) - 1 : y0;
            const fk = featureKey(cls, f);
            for (let x = xs; x <= x1; x++)
                for (let y = ys; y <= y1; y++) {
                    const tk = key(x, y);
                    if (!tiles.has(tk)) continue;
                    let list = keyed.get(tk);
                    if (!list) keyed.set(tk, (list = []));
                    list.push({ cls, f, key: fk });
                }
        }
    }
    for (const [tk, list] of keyed) {
        list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const tile = tiles.get(tk)!;
        let last = '';
        for (const { cls, f, key: fk } of list) {
            if (fk === last) continue;
            last = fk;
            tile[cls].features.push(f);
        }
    }
    return tiles;
}

/** FNV-1a (32-bit) of a tile's serialised content, as 8 hex digits. */
export function tileSignature(tile: PackOverlay | string): string {
    const text = typeof tile === 'string' ? tile : JSON.stringify(tile);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export type PackCoverage = 'full' | 'partial' | 'none';

/**
 * The overlay for `bbox` from the tiles at hand. `full` when every tile the
 * bbox touches is present, `none` when none is. Features held by two tiles are
 * used once. Obstacles are always used; water, marina basins, canal lines and
 * leading lines only where every tile of (their extent ∩ bbox) is present —
 * those left out for a missing tile are listed in `unsavedWater` (their
 * extents) so a route can say why it found no water there.
 *
 * With each tile's OSM date (`fetchedAt`, empty tiles included), an enabling
 * feature is also left out when a tile it reaches was saved LATER than every
 * tile holding it and does not hold it: that newer snapshot has superseded it
 * (2026-10-02 — a basin reclaimed since must not be routed on because an
 * older neighbouring tile still holds it). Obstacles stay the union: the
 * conservative way round. Where two tiles hold the same feature, the newest
 * tile's copy is the one used.
 */
export function assembleFromTiles(
    tiles: ReadonlyMap<string, PackOverlay>,
    bbox: Bbox,
    fetchedAt?: ReadonlyMap<string, number>,
): { overlay: PackOverlay; coverage: PackCoverage; presentKeys: string[]; unsavedWater: Bbox[] } {
    const overlay = emptyPackOverlay();
    const needed = tileKeysForBbox(bbox);
    const presentKeys = needed.filter((k) => tiles.has(k));
    const coverage: PackCoverage =
        presentKeys.length === 0 ? 'none' : presentKeys.length === needed.length ? 'full' : 'partial';
    const dateOf = (k: string): number | undefined => {
        const at = fetchedAt?.get(k);
        return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
    };
    // The newest tile first, so its copy of a shared feature is the one used.
    const order = [...presentKeys].sort((a, b) => (dateOf(b) ?? -Infinity) - (dateOf(a) ?? -Infinity));
    // Each tile's enabling feature keys, built when first asked for.
    const enablingKeys = new Map<string, Set<string>>();
    const holds = (tk: string, fk: string): boolean => {
        let keys = enablingKeys.get(tk);
        if (!keys) {
            keys = new Set<string>();
            const tile = tiles.get(tk);
            for (const cls of ENABLING_CLASSES)
                for (const f of tile?.[cls]?.features ?? []) keys.add(featureKey(cls, f));
            enablingKeys.set(tk, keys);
        }
        return keys.has(fk);
    };
    const superseded = (touched: readonly string[], fk: string): boolean => {
        let newestWith = -Infinity;
        let newestWithout = -Infinity;
        for (const k of touched) {
            const at = dateOf(k);
            if (at === undefined) continue;
            if (holds(k, fk)) newestWith = Math.max(newestWith, at);
            else newestWithout = Math.max(newestWithout, at);
        }
        return newestWithout > newestWith;
    };
    const seen = new Set<string>();
    const unsaved = new Map<string, Bbox>();
    for (const tk of order) {
        const tile = tiles.get(tk)!;
        for (const cls of OVERLAY_CLASSES) {
            for (const f of tile[cls]?.features ?? []) {
                const fk = featureKey(cls, f);
                if (seen.has(fk)) continue;
                const b = featureBbox(f);
                if (!b || !intersects(b, bbox)) continue;
                if (ENABLING_CLASSES.has(cls)) {
                    const part: Bbox = [
                        Math.max(b[0], bbox[0]),
                        Math.max(b[1], bbox[1]),
                        Math.min(b[2], bbox[2]),
                        Math.min(b[3], bbox[3]),
                    ];
                    // A feature meeting the bbox only at an edge touches no
                    // tile's interior: the tile holding it is enough.
                    const touched = part[0] < part[2] && part[1] < part[3] ? tileKeysForBbox(part) : [tk];
                    if (!touched.every((k) => tiles.has(k))) {
                        seen.add(fk);
                        unsaved.set(fk, b);
                        continue;
                    }
                    if (fetchedAt && superseded(touched, fk)) {
                        seen.add(fk);
                        continue;
                    }
                }
                seen.add(fk);
                overlay[cls].features.push(f);
            }
        }
    }
    return { overlay, coverage, presentKeys, unsavedWater: [...unsaved.values()] };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "28 Sep" — with the year when it is not this year's. Absolute, so a saved
 *  plan's caveat never goes false. */
export function dateWords(ms: number, now: number = Date.now()): string {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}
