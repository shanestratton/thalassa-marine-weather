/**
 * DIAGNOSTIC — does the route "line up the marks" into Tangalooma?
 *
 * Tangalooma Wrecks anchorage (Moreton Island, IALA-A) is approached on a
 * charted DOG-LEG leading-line transit:
 *   • outer leg ~072.5°  (RECTRC CATTRK=1 + NAVLNE)  → turn
 *   • inner leg ~031°    (RECTRC CATTRK=1 + NAVLNE)  → anchorage off the resort
 * Both legs carry front/rear yellow leading lights you keep in line.
 *
 * This harness loads the REAL AU ENC cell (OC-61-351824) live from the boat's
 * chart server, routes a vessel in from the bay to the anchorage, and measures
 * whether the produced track rides the two transit lines (mean/max perpendicular
 * offset) and whether the engine's leadingApproach / leadingLine provenance fired.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx vitest run tests/repro/tangaloomaLeads.diag.test.ts
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import type { Feature, FeatureCollection, LineString, Position } from 'geojson';
import {
    routeInshore,
    type InshoreLayers,
    type RouteResult,
    type RouteFailure,
} from '../../services/inshoreRouterEngine';

function piReachable(): boolean {
    try {
        execFileSync('curl', ['-s', '-f', '-m', '4', 'http://calypso.local:3001/api/enc/health'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
const PI_UP = piReachable();

const PI = 'http://calypso.local:3001/api/enc/installed';
const CELL = { id: 'OC-61-351824', path: '/tmp/tang_351824.json' };

// Vessel in from the bay (SW of the anchorage) → Tangalooma Wrecks anchorage.
const ORIGIN = { lat: -27.205, lon: 153.305 }; // open water, well SW in the bay
const DEST = { lat: -27.1772, lon: 153.3705 }; // anchorage off the resort, W of the rear lead

// The two charted transit lines (from the cell's NAVLNE), for offset measurement.
const OUTER: Position[] = [
    [153.34355, -27.19705],
    [153.36215, -27.19175],
    [153.36997, -27.18953],
];
const INNER: Position[] = [
    [153.36215, -27.19175],
    [153.36959, -27.1806],
    [153.37393, -27.17409],
];

type RawCell = { cellId: string; bbox: number[]; layers: Record<string, FeatureCollection> };

function ensureCell(): void {
    if (existsSync(CELL.path)) return;
    const out = execFileSync('curl', ['-s', '-f', `${PI}/${CELL.id}/data`], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(CELL.path, out);
}
function loadCell(): RawCell {
    const blob = JSON.parse(readFileSync(CELL.path, 'utf8')) as { cells?: RawCell[] };
    const cell = blob.cells?.find((c) => c.cellId === CELL.id) ?? blob.cells?.[0];
    if (!cell?.layers) throw new Error(`cell ${CELL.id} has no layers`);
    return cell;
}

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

function assemble(cell: RawCell): InshoreLayers {
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
        COASTLINE: { type: 'FeatureCollection', features: [] },
    };
    for (const layer of ALLOW) {
        const fc = cell.layers[layer];
        if (fc?.features) (merged[layer]!.features as unknown[]).push(...fc.features);
    }
    const nav = cell.layers['NAVLNE'];
    if (nav?.features) (merged.NAVLINE!.features as unknown[]).push(...nav.features);
    return merged;
}

function mPerDeg(refLat: number) {
    return { x: 111_320 * Math.cos((refLat * Math.PI) / 180), y: 111_320 };
}
function pointToSegM(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
    const { x: mx, y: my } = mPerDeg((aLat + bLat) / 2);
    const ax = aLon * mx,
        ay = aLat * my,
        bx = bLon * mx,
        by = bLat * my,
        px = pLon * mx,
        py = pLat * my;
    const dx = bx - ax,
        dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function pointToChainM(pLat: number, pLon: number, chain: Position[]): number {
    let best = Infinity;
    for (let i = 0; i + 1 < chain.length; i++) {
        const d = pointToSegM(pLat, pLon, chain[i][1], chain[i][0], chain[i + 1][1], chain[i + 1][0]);
        if (d < best) best = d;
    }
    return best;
}

describe('Tangalooma leading-line approach (diagnostic)', () => {
    let res: RouteResult | RouteFailure | null = null;
    beforeAll(() => {
        if (!PI_UP) return;
        ensureCell();
        const layers = assemble(loadCell());
        res = routeInshore(layers, {
            fromLat: ORIGIN.lat,
            fromLon: ORIGIN.lon,
            toLat: DEST.lat,
            toLon: DEST.lon,
            draftM: 2,
            safetyM: 1,
            resolutionM: 50,
        } as Parameters<typeof routeInshore>[1]);
    });

    it('reports provenance + transit offset', () => {
        if (!PI_UP) {
            console.log('SKIP — Pi unreachable');
            return;
        }
        expect(res).toBeTruthy();
        if (res && 'error' in res) {
            console.log('ROUTE FAILURE:', JSON.stringify(res));
            return;
        }
        const r = res as RouteResult;
        const dbg = (r as unknown as { debug?: Record<string, unknown> }).debug ?? {};
        console.log('\n=== PROVENANCE ===');
        console.log('engine        :', (r as unknown as { engine?: string }).engine);
        console.log('debug keys    :', Object.keys(dbg));
        console.log('threeTier     :', JSON.stringify(dbg.threeTier));
        console.log(
            'leadingApproach:',
            JSON.stringify(dbg.leadingApproach ?? (dbg as Record<string, unknown>).leading),
        );

        const poly = (r.polyline ?? []) as Position[];
        console.log('\n=== ROUTE ===  vertices:', poly.length);

        // Only the legs near Tangalooma (lon>153.33) — the bay run-in isn't on a lead.
        const tail = poly.filter((p) => p[0] > 153.33);
        const offOuter = tail.map((p) => pointToChainM(p[1], p[0], OUTER));
        const offInner = tail.map((p) => pointToChainM(p[1], p[0], INNER));
        const offBest = tail.map((_p, i) => Math.min(offOuter[i], offInner[i]));
        const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
        const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
        console.log('tail vertices near Tangalooma:', tail.length);
        console.log(
            'offset to nearest transit  mean(m):',
            mean(offBest).toFixed(1),
            ' max(m):',
            max(offBest).toFixed(1),
        );
        for (const p of tail) {
            const lon = p[0],
                lat = p[1];
            console.log(
                `  [${lon.toFixed(5)},${lat.toFixed(5)}]  outer=${pointToChainM(lat, lon, OUTER).toFixed(0)}m  inner=${pointToChainM(lat, lon, INNER).toFixed(0)}m`,
            );
        }
    });
});
