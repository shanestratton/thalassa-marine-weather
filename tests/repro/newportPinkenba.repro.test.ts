/**
 * REPRODUCTION HARNESS — Newport → Pinkenba "hugs the right side of the channel".
 *
 * Goal (per the routing-investigation brief):
 *   Confirm or refute that the wide-channel spans of the Newport→Pinkenba route
 *   run OFF the RECTRC (recommended-track) centreline — "hugging" one side —
 *   and pin the cause: leading-line (NAVLNE) override vs DRGARE centring
 *   suppression vs the RECTRC gap at the river bend.
 *
 * What this harness does
 * ──────────────────────
 *  1. Loads the REAL ENC corridor cells (OC-61-10ENB5 harbour + OC-61-10RCS5
 *     Newport exit) from /tmp/{enb5,rcs5}.json. Those files are curl'd from the
 *     Pi (`http://calypso.local:3001/api/enc/installed/<cell>/data`) in a setup
 *     step if they are missing — see ensureCells(). The /data endpoint returns
 *     {cells:[{cellId,bbox,layers:{LAYER:{features:[...]}}}]} which is exactly
 *     the on-device blob shape after loadCellGeoJSON unwraps it.
 *
 *  2. Assembles InshoreLayers per services/InshoreRouter.ts:376-417 — the FIXED
 *     10-layer allow-list copied verbatim from each cell:
 *        LNDARE DEPARE OBSTRN WRECKS UWTROC FAIRWY DRGARE BOYLAT BCNLAT RECTRC.
 *
 *     APPROXIMATIONS (the hard, network-only assembly bits — see the brief's
 *     "HARD-TO-REPLICATE" notes). All are faithful to an OFFLINE / Pi-unreachable
 *     run, where InshoreRouter.ts degrades to chart-only via its try/catch:
 *       • OSM overlay (getOsmRouteOverlay): SKIPPED. merged.NAVLINE/CANAL/
 *         COASTLINE therefore start empty. This is the legitimate offline path.
 *         NOTE the chart's own NAVLNE leading lines are NEVER mapped into
 *         merged.NAVLINE by the device assembly either (no NAVLNE→NAVLINE rename
 *         exists — Phase-1 ASSEMBLY finding) — so on-device, merged.NAVLINE is
 *         fed ONLY from OSM navLines. To probe the leading-line hypothesis we run
 *         a SECOND variant (B) that manually maps the cell's raw NAVLNE into
 *         merged.NAVLINE, isolating its effect.
 *       • Mapbox / satellite water: SKIPPED (only affects the canal/marina
 *         finegrid end-spans, not the wide-channel spans under test).
 *       • Supabase regional channel_midpoints (the _pairDistanceM markers that
 *         build governMark's suppression disc): SKIPPED. We rely on the chart's
 *         own BOYLAT/BCNLAT (which carry NO _pairDistanceM, so no mark-governed
 *         disc is built). This means the markGoverned centring-suppression
 *         clause is NOT exercised here; the DRGARE preferred-cell suppression
 *         (the other clause) IS, because DRGARE is loaded from the chart.
 *
 *  3. Calls routeInshore(layers, {Newport→Pinkenba, draftM 2, safetyM 1,
 *     resolutionM 50}) and captures debug.threeTier (the [3tier] provenance)
 *     plus the polyline.
 *
 *  4. MEASURES the hug: builds the authoritative RECTRC river centreline chain
 *     and the DRGARE dredged-area polygons from the SAME cell data, then for the
 *     river portion of the route computes the mean + max perpendicular offset
 *     from (a) the nearest RECTRC segment and (b) reports whether each sampled
 *     route point sits inside a DRGARE polygon (on the dredged channel) and how
 *     far it is from the DRGARE medial line approximated by the RECTRC.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx vitest run tests/repro/newportPinkenba.repro.test.ts
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { Feature, FeatureCollection, LineString, Polygon, Position } from 'geojson';

import {
    routeInshore,
    type InshoreLayers,
    type RouteRequest,
    type RouteResult,
} from '../../services/inshoreRouterEngine';
import { snapRouteToCanalLines, parseCanalLines } from '../../services/tier3/canalLineFollower';

// This harness routes on the REAL ENC pulled live from the boat's chart server
// (calypso.local). It is a DIAGNOSTIC, not a CI gate — when the Pi is unreachable
// (CI, another machine) the whole suite skips cleanly rather than failing.
function piReachable(): boolean {
    try {
        execFileSync('curl', ['-s', '-f', '-m', '4', 'http://calypso.local:3001/api/enc/health'], {
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}
const PI_UP = piReachable();

// ── Route under test ────────────────────────────────────────────────
const NEWPORT = { lat: -27.2141, lon: 153.0877 };
const PINKENBA = { lat: -27.4477, lon: 153.0936 };

// ── Corridor cells (the real ENC). enb5 = harbour (all the RECTRC/DRGARE/
//    NAVLNE), rcs5 = Newport exit (1 RECTRC + 1 NAVLNE). ─────────────
const PI = 'http://calypso.local:3001/api/enc/installed';
const CELLS = [
    { id: 'OC-61-10ENB5', path: '/tmp/enb5.json' },
    { id: 'OC-61-10RCS5', path: '/tmp/rcs5.json' },
];

// ── REAL OSM overlay navLines (the ACTUAL on-device merged.NAVLINE source —
//    there is no chart NAVLNE→NAVLINE rename; on-device NAVLINE comes SOLELY
//    from getOsmRouteOverlay's navLines, InshoreRouter.ts:692-697). Served by
//    the same Pi. These are the real `+lead×N` puller from the device log. ──
const OSM_OVERLAY = 'http://calypso.local:3001/api/osm/overlay';
const OSM_BBOX = '153.05,-27.48,153.25,-27.15'; // covers Newport→bay→river→Pinkenba
const OSM_PATH = '/tmp/osm_overlay_repro.json';

// ── Geometry helpers ────────────────────────────────────────────────
const R_EARTH = 6_371_000;
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/** Local-tangent metres-per-degree at a reference latitude. */
function mPerDeg(refLat: number): { x: number; y: number } {
    return { x: 111_320 * Math.cos((refLat * Math.PI) / 180), y: 111_320 };
}

/** Perpendicular distance (m) from point P to segment A–B, in a local planar frame. */
function pointToSegM(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
    const refLat = (aLat + bLat) / 2;
    const { x: mx, y: my } = mPerDeg(refLat);
    const ax = aLon * mx,
        ay = aLat * my;
    const bx = bLon * mx,
        by = bLat * my;
    const px = pLon * mx,
        py = pLat * my;
    const dx = bx - ax,
        dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx,
        cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}

/** Min perpendicular distance (m) from a point to a polyline chain (list of segments). */
function pointToChainM(pLat: number, pLon: number, chain: Position[]): number {
    let best = Infinity;
    for (let i = 0; i + 1 < chain.length; i++) {
        const [aLon, aLat] = chain[i];
        const [bLon, bLat] = chain[i + 1];
        const d = pointToSegM(pLat, pLon, aLat, aLon, bLat, bLon);
        if (d < best) best = d;
    }
    return best;
}

/**
 * SIGNED perpendicular offset (m) from a point to the nearest chain segment.
 * Positive = the point lies to the LEFT of the chain's direction of travel,
 * negative = to the RIGHT. Used to tell a one-sided HUG from centred noise:
 * a hug shows a consistent sign (mean |signed| ≈ mean unsigned); centred
 * wander shows mean signed ≈ 0 with non-trivial unsigned spread.
 */
function signedOffsetM(pLat: number, pLon: number, chain: Position[]): number {
    let best = Infinity;
    let signed = 0;
    for (let i = 0; i + 1 < chain.length; i++) {
        const [aLon, aLat] = chain[i];
        const [bLon, bLat] = chain[i + 1];
        const d = pointToSegM(pLat, pLon, aLat, aLon, bLat, bLon);
        if (d < best) {
            best = d;
            const refLat = (aLat + bLat) / 2;
            const { x: mx, y: my } = mPerDeg(refLat);
            const dx = (bLon - aLon) * mx;
            const dy = (bLat - aLat) * my;
            const px = (pLon - aLon) * mx;
            const py = (pLat - aLat) * my;
            const cross = dx * py - dy * px; // >0 ⇒ point left of travel
            signed = cross >= 0 ? d : -d;
        }
    }
    return signed;
}

/** Ray-cast point-in-ring. Coords are [lon,lat]. */
function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0],
            yi = ring[i][1];
        const xj = ring[j][0],
            yj = ring[j][1];
        const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function pointInAnyPolygon(lon: number, lat: number, polys: Feature[]): boolean {
    for (const f of polys) {
        const g = f.geometry as Polygon | undefined;
        if (!g) continue;
        if (g.type === 'Polygon') {
            if (g.coordinates.length && pointInRing(lon, lat, g.coordinates[0] as Position[])) return true;
        } else if ((g as { type?: string }).type === 'MultiPolygon') {
            for (const poly of (g as unknown as { coordinates: Position[][][] }).coordinates) {
                if (poly.length && pointInRing(lon, lat, poly[0])) return true;
            }
        }
    }
    return false;
}

// ── Cell loading ────────────────────────────────────────────────────
type RawCell = { cellId: string; bbox: number[]; layers: Record<string, FeatureCollection> };

function ensureCells(): void {
    for (const c of CELLS) {
        if (existsSync(c.path)) continue;
        // Curl the /data endpoint to /tmp. Done in a setup step (not under the
        // vitest network sandbox) so the route call reads a stable local file.
        try {
            const out = execFileSync('curl', ['-s', '-f', `${PI}/${c.id}/data`], {
                maxBuffer: 64 * 1024 * 1024,
            });
            require('node:fs').writeFileSync(c.path, out);
        } catch (e) {
            throw new Error(`failed to fetch ${c.id} from Pi (${PI}); is calypso.local reachable? ${String(e)}`);
        }
    }
}

function loadCell(path: string, id: string): RawCell {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as { cells?: RawCell[] } & Partial<RawCell>;
    // /data shape is {cells:[...]}; device blob shape is top-level .layers.
    const cell = blob.cells ? (blob.cells.find((c) => c.cellId === id) ?? blob.cells[0]) : (blob as RawCell);
    if (!cell?.layers) throw new Error(`cell ${id} has no layers`);
    return cell;
}

/** Curl the REAL OSM overlay (the on-device navLines source) to /tmp once. */
function ensureOsm(): void {
    if (existsSync(OSM_PATH)) return;
    try {
        const out = execFileSync('curl', ['-s', '-f', `${OSM_OVERLAY}?bbox=${OSM_BBOX}`], {
            maxBuffer: 64 * 1024 * 1024,
        });
        require('node:fs').writeFileSync(OSM_PATH, out);
    } catch (e) {
        throw new Error(`failed to fetch OSM overlay from Pi; is calypso.local reachable? ${String(e)}`);
    }
}

/** The real OSM navLines (LineString FeatureCollection), pushed 1:1 into NAVLINE
 *  exactly as InshoreRouter.ts:692-697 does on-device. */
function loadOsmNavLines(): Feature[] {
    const d = JSON.parse(readFileSync(OSM_PATH, 'utf8')) as { navLines?: FeatureCollection };
    return (d.navLines?.features ?? []) as Feature[];
}

/** The real OSM canal centre-lines (LineString FeatureCollection), pushed 1:1 into
 *  CANAL exactly as InshoreRouter.ts:677 does on-device — the lines tier-3 follows. */
function loadOsmCanalLines(): Feature[] {
    const d = JSON.parse(readFileSync(OSM_PATH, 'utf8')) as { canalLines?: FeatureCollection };
    return (d.canalLines?.features ?? []) as Feature[];
}

/**
 * Assemble InshoreLayers per InshoreRouter.ts:376-417 — the fixed allow-list,
 * verbatim concat across cells. `mapNavlne` controls variant B (map the cell's
 * raw NAVLNE leading lines into merged.NAVLINE to isolate the leading-line snap).
 */
const ALLOW = [
    'LNDARE',
    'DEPARE',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'FAIRWY',
    'DRGARE',
    'BOYLAT',
    'BCNLAT',
    'RECTRC',
] as const;

type NavSource = 'none' | 'chart' | 'osm';

function assembleLayers(cells: RawCell[], navSource: NavSource, osmNav: Feature[], osmCanal: Feature[]): InshoreLayers {
    const merged: InshoreLayers = {
        LNDARE: { type: 'FeatureCollection', features: [] },
        DEPARE: { type: 'FeatureCollection', features: [] },
        OBSTRN: { type: 'FeatureCollection', features: [] },
        WRECKS: { type: 'FeatureCollection', features: [] },
        UWTROC: { type: 'FeatureCollection', features: [] },
        FAIRWY: { type: 'FeatureCollection', features: [] },
        DRGARE: { type: 'FeatureCollection', features: [] },
        BOYLAT: { type: 'FeatureCollection', features: [] },
        BCNLAT: { type: 'FeatureCollection', features: [] },
        RECTRC: { type: 'FeatureCollection', features: [] },
        NAVLINE: { type: 'FeatureCollection', features: [] },
        CANAL: { type: 'FeatureCollection', features: [] },
    };
    for (const cell of cells) {
        for (const layer of ALLOW) {
            const fc = cell.layers[layer];
            const target = merged[layer];
            if (fc?.features && Array.isArray(fc.features) && target) {
                (target.features as unknown[]).push(...fc.features);
            }
        }
        // Variant B only: the device assembly does NOT do this (no NAVLNE→NAVLINE
        // rename), so on-device NAVLINE comes solely from OSM. We map the chart's
        // own off-centre NAVLNE in to test whether it is the puller.
        if (navSource === 'chart') {
            const nav = cell.layers['NAVLNE'];
            if (nav?.features) (merged.NAVLINE!.features as unknown[]).push(...nav.features);
        }
    }
    // Variant C: the FAITHFUL on-device path — push the REAL OSM navLines into
    // NAVLINE exactly as InshoreRouter.ts:692-697. This is the actual `+lead×N`
    // puller from the device log.
    if (navSource === 'osm') {
        (merged.NAVLINE!.features as unknown[]).push(...osmNav);
        // The device ALSO pushes OSM canalLines into CANAL (InshoreRouter.ts:677) —
        // the canal centre-lines the tier-3 follower rides. Faithful on-device path.
        (merged.CANAL!.features as unknown[]).push(...osmCanal);
    }
    return merged;
}

// ── RECTRC river-centreline chain assembly ──────────────────────────
// The brief established: the river corridor RECTRC chains are the CATTRK=1
// segments (CATTRK=2 are the far-east Moreton Bay deep-water shipping channel).
// We build an ordered chain by greedy nearest-endpoint stitching of the
// CATTRK=1 segments that lie in the RIVER PROPER, starting from the bay-mouth
// end and walking toward Pinkenba.
//
// Corridor cut: midLon < 153.16. This keeps the 9 river-proper segments
// (2,3,4,5,8,9,10,11,12 in OC-61-10ENB5) and drops (a) the far-east bay
// shipping channel (lon>153.21), (b) the east branch seg 7 (~153.20), AND
// (c) the long generalised bay straight seg 6 (head 153.2324→tail 153.1552,
// a single 14.5 km chart-design straight — measuring offset against it is
// meaningless, so it is excluded; the route's bay run is not part of the
// "hug" question, only the dredged river is).
function buildRectrcRiverChain(rectrc: Feature[]): Position[] {
    const RIVER_PROPER_MAX_LON = 153.16;
    // Latitude floor: the river-proper RECTRC sits south of -27.38. This also
    // drops the rcs5 Newport-exit RECTRC (~-27.167), which is a separate marina
    // track disconnected from the river by the open bay and would otherwise be
    // picked as the chain head (it is the northernmost endpoint) and strand the
    // stitch at 2 points.
    const RIVER_PROPER_MAX_LAT = -27.36;
    const segs: Position[][] = [];
    for (const f of rectrc) {
        const g = f.geometry as LineString | undefined;
        if (!g || g.type !== 'LineString') continue;
        const cattrk = (f.properties as Record<string, unknown> | null)?.CATTRK;
        // Keep recommended-track CATTRK=1 (one-way) river segments only.
        if (cattrk !== 1 && cattrk !== '1') continue;
        const coords = g.coordinates as Position[];
        if (coords.length < 2) continue;
        const midLon = (coords[0][0] + coords[coords.length - 1][0]) / 2;
        const midLat = (coords[0][1] + coords[coords.length - 1][1]) / 2;
        if (midLon >= RIVER_PROPER_MAX_LON) continue;
        if (midLat >= RIVER_PROPER_MAX_LAT) continue;
        segs.push(coords);
    }
    if (segs.length === 0) return [];
    // Greedy stitch: start at the northern/bay end (max lat), walk to min lat.
    const used = new Array(segs.length).fill(false);
    // Pick the seg whose endpoint is furthest north as the head.
    let headIdx = 0;
    let headEnd = 0; // 0 = use coords as-is, 1 = reversed
    let bestLat = -Infinity;
    segs.forEach((s, i) => {
        const a = s[0][1],
            b = s[s.length - 1][1];
        if (a > bestLat) {
            bestLat = a;
            headIdx = i;
            headEnd = 0;
        }
        if (b > bestLat) {
            bestLat = b;
            headIdx = i;
            headEnd = 1;
        }
    });
    const chain: Position[] = [];
    let cur = headEnd === 0 ? segs[headIdx].slice() : segs[headIdx].slice().reverse();
    used[headIdx] = true;
    chain.push(...cur);
    // Repeatedly append the nearest unused segment endpoint to the chain tail.
    for (let n = 1; n < segs.length; n++) {
        const tail = chain[chain.length - 1];
        let bestI = -1;
        let bestRev = false;
        let bestD = Infinity;
        for (let i = 0; i < segs.length; i++) {
            if (used[i]) continue;
            const s = segs[i];
            const dHead = haversineM(tail[1], tail[0], s[0][1], s[0][0]);
            const dTail = haversineM(tail[1], tail[0], s[s.length - 1][1], s[s.length - 1][0]);
            if (dHead < bestD) {
                bestD = dHead;
                bestI = i;
                bestRev = false;
            }
            if (dTail < bestD) {
                bestD = dTail;
                bestI = i;
                bestRev = true;
            }
        }
        if (bestI < 0 || bestD > 3000) break; // don't bridge a >3 km jump
        used[bestI] = true;
        const seg = bestRev ? segs[bestI].slice().reverse() : segs[bestI].slice();
        chain.push(...seg.slice(1)); // avoid duplicating the shared vertex
    }
    return chain;
}

/** Densify a chain so perpendicular sampling is dense enough (every ~stepM). */
function densify(chain: Position[], stepM: number): Position[] {
    if (chain.length < 2) return chain.slice();
    const out: Position[] = [chain[0]];
    for (let i = 0; i + 1 < chain.length; i++) {
        const [aLon, aLat] = chain[i];
        const [bLon, bLat] = chain[i + 1];
        const segM = haversineM(aLat, aLon, bLat, bLon);
        const steps = Math.max(1, Math.ceil(segM / stepM));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            out.push([aLon + (bLon - aLon) * t, aLat + (bLat - aLat) * t]);
        }
    }
    return out;
}

// ── Fixtures shared across the variant tests ────────────────────────
let cells: RawCell[];
let rectrcChain: Position[];
let drgarePolys: Feature[];
let osmNav: Feature[];
let osmCanal: Feature[];

beforeAll(() => {
    ensureCells();
    ensureOsm();
    cells = CELLS.map((c) => loadCell(c.path, c.id));
    const allRectrc = cells.flatMap((c) => c.layers['RECTRC']?.features ?? []);
    rectrcChain = buildRectrcRiverChain(allRectrc as Feature[]);
    drgarePolys = cells.flatMap((c) => (c.layers['DRGARE']?.features ?? []) as Feature[]);
    osmNav = loadOsmNavLines();
    osmCanal = loadOsmCanalLines();
});

// ── The reproduction ────────────────────────────────────────────────
const REQ_BASE: Omit<RouteRequest, never> = {
    fromLat: NEWPORT.lat,
    fromLon: NEWPORT.lon,
    toLat: PINKENBA.lat,
    toLon: PINKENBA.lon,
    draftM: 2,
    safetyM: 1,
    resolutionM: 50,
};

type HugReport = {
    riverPts: number;
    meanRectrcM: number;
    maxRectrcM: number;
    fracInsideDrgare: number;
    p90RectrcM: number;
    /** Mean SIGNED offset (+left / −right of travel). |meanSigned|≈mean ⇒ hug. */
    meanSignedM: number;
};

/** Measure the route's offset from the RECTRC chain over the RIVER portion. */
function measureHug(route: RouteResult): HugReport {
    // Densify the route so we sample the whole polyline, not just vertices.
    const dense = densify(route.polyline, 50);
    // River portion = where the RECTRC river chain actually provides a
    // reference centreline: lat in [-27.448, -27.388], lon<153.16. (North of
    // the chain head the only RECTRC is the generalised bay straight, which is
    // not a centring reference — excluded.)
    const offs: number[] = [];
    let signedSum = 0;
    let inDrg = 0;
    let n = 0;
    for (const [lon, lat] of dense) {
        if (lat > -27.388 || lat < -27.448) continue;
        if (lon > 153.16) continue;
        n++;
        offs.push(pointToChainM(lat, lon, rectrcChain));
        signedSum += signedOffsetM(lat, lon, rectrcChain);
        if (pointInAnyPolygon(lon, lat, drgarePolys)) inDrg++;
    }
    offs.sort((a, b) => a - b);
    const mean = offs.length ? offs.reduce((s, v) => s + v, 0) / offs.length : NaN;
    const max = offs.length ? offs[offs.length - 1] : NaN;
    const p90 = offs.length ? offs[Math.floor(offs.length * 0.9)] : NaN;
    return {
        riverPts: n,
        meanRectrcM: mean,
        maxRectrcM: max,
        fracInsideDrgare: n ? inDrg / n : NaN,
        p90RectrcM: p90,
        meanSignedM: n ? signedSum / n : NaN,
    };
}

function runVariant(navSource: NavSource): { route: RouteResult; prov: string; hug: HugReport } {
    const layers = assembleLayers(cells, navSource, osmNav, osmCanal);
    const res = routeInshore(layers, REQ_BASE as RouteRequest);
    if ('error' in res) throw new Error(`route failed: ${res.error} (${res.code ?? 'no-code'})`);
    const prov = res.debug?.threeTier ?? '(no threeTier — monolith fallback)';
    const hug = measureHug(res);
    return { route: res, prov, hug };
}

describe.skipIf(!PI_UP)('Newport → Pinkenba — hug reproduction against real ENC', () => {
    it('sanity: RECTRC river chain + DRGARE assembled from the real cells', () => {
        // eslint-disable-next-line no-console
        console.log(
            'SANITY cells=',
            cells.length,
            'rectrcFeatures=',
            cells.flatMap((c) => c.layers['RECTRC']?.features ?? []).length,
            'chainPts=',
            rectrcChain.length,
            'drgare=',
            drgarePolys.length,
            'chainHead=',
            rectrcChain[0],
            'chainTail=',
            rectrcChain[rectrcChain.length - 1],
        );
        expect(rectrcChain.length).toBeGreaterThan(5);
        expect(drgarePolys.length).toBeGreaterThan(10);
        // Chain should span the river proper: top near -27.388, bottom near -27.448.
        const lats = rectrcChain.map((p) => p[1]);
        expect(Math.min(...lats)).toBeLessThan(-27.44);
        expect(Math.max(...lats)).toBeGreaterThan(-27.39);
    });

    it('VARIANT A — chart-only (offline-equivalent, NAVLINE empty): runs + measures hug', () => {
        const { route, prov, hug } = runVariant('none');
        // eslint-disable-next-line no-console
        console.log('\n=== VARIANT A (chart-only / NAVLINE empty) ===');
        // eslint-disable-next-line no-console
        console.log('prov  :', prov);
        // eslint-disable-next-line no-console
        console.log('points:', route.polyline.length, ' distanceNM:', route.distanceNM.toFixed(2));
        // eslint-disable-next-line no-console
        console.log(
            `hug   : riverPts=${hug.riverPts} meanFromRECTRC=${hug.meanRectrcM.toFixed(0)}m ` +
                `meanSigned=${hug.meanSignedM.toFixed(0)}m(${hug.meanSignedM >= 0 ? 'LEFT' : 'RIGHT'}) ` +
                `p90=${hug.p90RectrcM.toFixed(0)}m max=${hug.maxRectrcM.toFixed(0)}m insideDRGARE=${(
                    hug.fracInsideDrgare * 100
                ).toFixed(0)}%`,
        );
        expect(route.polyline.length).toBeGreaterThanOrEqual(2);
        expect(hug.riverPts).toBeGreaterThan(0);
    });

    it('VARIANT B — chart NAVLNE mapped into NAVLINE (isolates the leading-line snap)', () => {
        const { route, prov, hug } = runVariant('chart');
        // eslint-disable-next-line no-console
        console.log('\n=== VARIANT B (chart NAVLNE → NAVLINE) ===');
        // eslint-disable-next-line no-console
        console.log('prov  :', prov);
        // eslint-disable-next-line no-console
        console.log('points:', route.polyline.length, ' distanceNM:', route.distanceNM.toFixed(2));
        // eslint-disable-next-line no-console
        console.log(
            `hug   : riverPts=${hug.riverPts} meanFromRECTRC=${hug.meanRectrcM.toFixed(0)}m ` +
                `meanSigned=${hug.meanSignedM.toFixed(0)}m(${hug.meanSignedM >= 0 ? 'LEFT' : 'RIGHT'}) ` +
                `p90=${hug.p90RectrcM.toFixed(0)}m max=${hug.maxRectrcM.toFixed(0)}m insideDRGARE=${(
                    hug.fracInsideDrgare * 100
                ).toFixed(0)}%`,
        );
        expect(route.polyline.length).toBeGreaterThanOrEqual(2);
        expect(hug.riverPts).toBeGreaterThan(0);
    });

    it('VARIANT C — REAL OSM navLines → NAVLINE (the actual on-device puller)', () => {
        const { route, prov, hug } = runVariant('osm');
        // eslint-disable-next-line no-console
        console.log('\n=== VARIANT C (REAL OSM navLines → NAVLINE) ===');
        // eslint-disable-next-line no-console
        console.log('osmNavLines:', osmNav.length);
        // eslint-disable-next-line no-console
        console.log('prov  :', prov);
        // eslint-disable-next-line no-console
        console.log('points:', route.polyline.length, ' distanceNM:', route.distanceNM.toFixed(2));
        // eslint-disable-next-line no-console
        console.log(
            `hug   : riverPts=${hug.riverPts} meanFromRECTRC=${hug.meanRectrcM.toFixed(0)}m ` +
                `meanSigned=${hug.meanSignedM.toFixed(0)}m(${hug.meanSignedM >= 0 ? 'LEFT' : 'RIGHT'}) ` +
                `p90=${hug.p90RectrcM.toFixed(0)}m max=${hug.maxRectrcM.toFixed(0)}m insideDRGARE=${(
                    hug.fracInsideDrgare * 100
                ).toFixed(0)}%`,
        );
        expect(route.polyline.length).toBeGreaterThanOrEqual(2);
        expect(hug.riverPts).toBeGreaterThan(0);
    });

    it('DIFF — A (none) vs B (chart NAVLNE) vs C (real OSM navLines): which hugs?', () => {
        const a = runVariant('none');
        const b = runVariant('chart');
        const c = runVariant('osm');
        const fmt = (x: { hug: HugReport }) =>
            `mean=${x.hug.meanRectrcM.toFixed(0)}m signed=${x.hug.meanSignedM.toFixed(0)}m ` +
            `p90=${x.hug.p90RectrcM.toFixed(0)}m max=${x.hug.maxRectrcM.toFixed(0)}m ` +
            `inDRGARE=${(x.hug.fracInsideDrgare * 100).toFixed(0)}%`;
        // eslint-disable-next-line no-console
        console.log('\n=== DIFF A vs B vs C (offset from RECTRC river centreline) ===');
        // eslint-disable-next-line no-console
        console.log(`A none : ${fmt(a)}\n         prov: ${a.prov}`);
        // eslint-disable-next-line no-console
        console.log(`B chart: ${fmt(b)}\n         prov: ${b.prov}`);
        // eslint-disable-next-line no-console
        console.log(`C OSM  : ${fmt(c)}\n         prov: ${c.prov}`);
        // The protect fix is ACTIVE in the engine here, so C's provenance reflects
        // the AFTER state. To capture BEFORE, run with the engine RECTRC-protect
        // stashed (see the run script in the response). Always-pass reporter.
        expect(true).toBe(true);
    });

    it('CANAL SNAP — Newport canal rides dead centre, river left untouched', () => {
        // Variant C = the faithful on-device path (CANAL populated). The Newport
        // canal comes out tier-2 passthrough here (the lines carve navigable water),
        // i.e. the raw A* wall-hug. snapRouteToCanalLines should pull it dead centre,
        // while the RECTRC-followed river at the Pinkenba end stays byte-identical.
        const { route, prov } = runVariant('osm');
        const lines = parseCanalLines(osmCanal as Parameters<typeof parseCanalLines>[0]);
        expect(lines.length).toBeGreaterThan(10);

        // Mean perpendicular offset (m) from the canal lines over the NEWPORT CANAL
        // INTERIOR (lat −27.213..−27.203 — excludes the marina berth + the bay exit,
        // which legitimately sit off the lines), densified so we sample the path.
        // Distance is to the nearest line SEGMENT (not vertex): the canal lines have
        // long straight runs, so a vertex metric falsely reports a mid-segment point
        // as far off even when it rides the line exactly.
        const interiorOffset = (poly: Position[]): { mean: number; n: number } => {
            let sum = 0;
            let n = 0;
            for (const [lon, lat] of densify(poly, 20)) {
                if (lat > -27.203 || lat < -27.213 || lon < 153.082 || lon > 153.095) continue;
                let best = Infinity;
                for (const ln of lines) {
                    const d = pointToChainM(lat, lon, ln as unknown as Position[]);
                    if (d < best) best = d;
                }
                sum += best;
                n++;
            }
            return { mean: n ? sum / n : NaN, n };
        };

        // The engine now applies the snap internally, so route.polyline is the
        // FINAL on-device geometry. Verify it rides the canal centre + the snap
        // engaged (+canalsnap), and that re-snapping leaves the river byte-identical.
        const off = interiorOffset(route.polyline);
        const resnapped = snapRouteToCanalLines(route.polyline, lines);
        const river = (poly: readonly (readonly number[])[]): string =>
            JSON.stringify(poly.filter(([, la]) => la < -27.38));
        // eslint-disable-next-line no-console
        console.log(
            `\n=== CANAL SNAP (engine output) ===\nNewport canal interior: mean=${off.mean.toFixed(1)}m (n=${off.n})\n` +
                `prov: ${prov}\nriver untouched by snap: ${river(resnapped) === river(route.polyline)}`,
        );
        expect(off.n).toBeGreaterThan(0);
        expect(off.mean, 'engine routes the canal dead centre').toBeLessThan(10);
        expect(prov, 'canal-line snap engaged').toContain('canalsnap');
        expect(river(resnapped), 'snap leaves the river alone').toBe(river(route.polyline));
    });
});
