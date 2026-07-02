/**
 * SERENE SUMMER HOMECOMING — Mooloolaba Wharf Marina → Newport channel.
 *
 * Shane sails this tomorrow. Three variants on the REAL installed cells with
 * the device-faithful enrichment:
 *   A) SAFEST     — default profile (keel + 0.5 m honoured everywhere)
 *   B) SHORTEST   — tideAssist profile (the inside run past the southern-
 *                   Bribie / "Gilligans Island" bank: ~2.0 m charted, needs
 *                   ≥ +0.9 m above LAT for the 2.4 m keel) + TIDE WINDOWS
 *                   for tomorrow from the live extremes curve
 *   C) PEARL CH.  — via-point variant through Pearl Channel (two-leg stitch)
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx vitest run tests/repro/mooloolabaHomecoming.diag.test.ts
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import type { FeatureCollection, Feature, Position } from 'geojson';
import { routeInshore, type InshoreLayers, type RouteResult } from '../../services/inshoreRouterEngine';
import { shadowingCells, featureIsShadowed } from '../../services/enc/scaleShadow';
import { computeTidalWindows } from '../../services/routing/tidalWindow';
import { fetchTideCurve } from '../../services/TideHeightService';
import { tideFieldFromCurve } from '../../services/routing/env/EnvFields';

function piReachable(): boolean {
    try {
        execFileSync('curl', ['-s', '-f', '-m', '4', 'http://calypso.local:3001/api/enc/health'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
const PI_UP = piReachable();
const CACHE_DIR = '/tmp/baySweepCells';

// ── Endpoints + via ──────────────────────────────────────────────────
const MOOLOOLABA_WHARF: [number, number] = [153.1239, -26.6832]; // in the Mooloolah River
const NEWPORT_CHANNEL: [number, number] = [153.0952, -27.2088]; // home channel mouth
// Pearl Channel spine probed from the real cells: lon ≈153.22 carries 5-10 m
// continuously from -27.02 to -27.14 (transects in __bribieProbe). Enter from
// the north, run the spine south, exit toward Deception Bay.
const PEARL_N: [number, number] = [153.222, -27.03];
const PEARL_S: [number, number] = [153.22, -27.132];

type RawCell = { cellId: string; bbox: number[]; layers: Record<string, FeatureCollection> };
interface CellMeta {
    cellId: string;
    bbox: [number, number, number, number];
}

function listInstalled(): CellMeta[] {
    const out = execFileSync('curl', ['-s', '-f', '-m', '10', 'http://calypso.local:3001/api/enc/installed'], {
        maxBuffer: 8 * 1024 * 1024,
    }).toString();
    const parsed = JSON.parse(out) as { cells?: CellMeta[] } | CellMeta[];
    const cells = Array.isArray(parsed) ? parsed : (parsed.cells ?? []);
    return cells.filter((c) => c.cellId.startsWith('OC-'));
}

function fetchCell(cellId: string): RawCell | null {
    mkdirSync(CACHE_DIR, { recursive: true });
    const path = `${CACHE_DIR}/${cellId}.json`;
    if (!existsSync(path)) {
        try {
            const out = execFileSync(
                'curl',
                ['-s', '-f', `http://calypso.local:3001/api/enc/installed/${cellId}/data`],
                { maxBuffer: 128 * 1024 * 1024 },
            );
            writeFileSync(path, out);
        } catch {
            return null;
        }
    }
    try {
        const blob = JSON.parse(readFileSync(path, 'utf8')) as { cells?: RawCell[] };
        return blob.cells?.find((c) => c.cellId === cellId) ?? blob.cells?.[0] ?? null;
    } catch {
        return null;
    }
}

function fetchOsmOverlay(bbox: [number, number, number, number]): Record<string, FeatureCollection> | null {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const out = execFileSync(
                'curl',
                ['-s', '-f', '-m', '30', `http://calypso.local:3001/api/osm/overlay?bbox=${bbox.join(',')}`],
                { maxBuffer: 128 * 1024 * 1024 },
            ).toString();
            const parsed = JSON.parse(out) as Record<string, FeatureCollection>;
            const total = ['water', 'coastline', 'canalLines'].reduce(
                (n, k) => n + (parsed[k]?.features?.length ?? 0),
                0,
            );
            if (total > 0) return parsed;
        } catch {
            /* retry */
        }
    }
    return null;
}

const ROUTING_LAYERS = [
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

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);
const distM = (a: Position, b: Position): number =>
    Math.hypot((b[0] - a[0]) * mPerLon((a[1] + b[1]) / 2), (b[1] - a[1]) * M_PER_LAT);

async function assemble(from: [number, number], to: [number, number]): Promise<InshoreLayers> {
    const pad = 0.15; // wide enough that Pearl Channel + both approaches share full data
    const bbox: [number, number, number, number] = [
        Math.min(from[0], to[0]) - pad,
        Math.min(from[1], to[1]) - pad,
        Math.max(from[0], to[0]) + pad,
        Math.max(from[1], to[1]) + pad,
    ];
    const installed = listInstalled();
    const candidates = installed.filter(
        (c) => bbox[0] <= c.bbox[2] && bbox[2] >= c.bbox[0] && bbox[1] <= c.bbox[3] && bbox[3] >= c.bbox[1],
    );
    const extents = candidates.map((c) => ({ id: c.cellId, bbox: c.bbox }));
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
    for (const c of candidates) {
        const raw = fetchCell(c.cellId);
        if (!raw) continue;
        const shadows = shadowingCells({ id: c.cellId, bbox: c.bbox }, extents);
        for (const layer of ROUTING_LAYERS) {
            const fc = raw.layers[layer];
            if (!fc?.features) continue;
            const feats =
                (layer === 'LNDARE' || layer === 'DEPARE') && shadows.length > 0
                    ? fc.features.filter((f) => !featureIsShadowed(f, shadows))
                    : fc.features;
            (merged[layer]!.features as unknown[]).push(...feats);
        }
        const nav = raw.layers['NAVLNE'];
        if (nav?.features) (merged.NAVLINE!.features as unknown[]).push(...nav.features);
    }
    // Device enrichment: OSM overlay + SE-QLD markers.
    const overlay = fetchOsmOverlay(bbox);
    if (overlay) {
        const water = (overlay.water?.features ?? []) as Feature[];
        (merged.DEPARE!.features as unknown[]).push(
            ...water.map((f) => ({ ...f, properties: { ...(f.properties ?? {}), DRVAL1: 10.0, DRVAL2: 10.0 } })),
        );
        (merged.DEPARE!.features as unknown[]).push(
            ...((overlay.marina?.features ?? []) as Feature[]).map((f) => ({
                ...f,
                properties: { ...(f.properties ?? {}), DRVAL1: 5.0, DRVAL2: 5.0 },
            })),
        );
        (merged.OBSTRN!.features as unknown[]).push(
            ...((overlay.reef?.features ?? []) as Feature[]).map((f) => ({
                ...f,
                properties: { ...(f.properties ?? {}), _class: 'osm-reef' },
            })),
        );
        for (const f of (overlay.breakwater?.features ?? []) as Feature[]) {
            const t = f.geometry?.type;
            if (t === 'Polygon' || t === 'MultiPolygon') (merged.LNDARE!.features as unknown[]).push(f);
            else if (t === 'LineString' || t === 'MultiLineString') (merged.COASTLINE!.features as unknown[]).push(f);
        }
        (merged.OBSTRN!.features as unknown[]).push(
            ...((overlay.aeroway?.features ?? []) as Feature[])
                .filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
                .map((f) => ({ ...f, properties: { ...(f.properties ?? {}), _class: 'osm-aeroway' } })),
        );
        (merged.COASTLINE!.features as unknown[]).push(...((overlay.coastline?.features ?? []) as unknown[]));
        (merged.CANAL!.features as unknown[]).push(...((overlay.canalLines?.features ?? []) as unknown[]));
        (merged.NAVLINE!.features as unknown[]).push(...((overlay.navLines?.features ?? []) as unknown[]));
    }
    try {
        const { fetchRegionalMarkers, orientHazardsTowardLand } = await import('../../services/InshoreRouter');
        const url =
            'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/regions/australia_se_qld/nav_markers.geojson';
        const { midpoints, segments, hazards, wings } = await fetchRegionalMarkers(
            url,
            (merged.LNDARE?.features ?? []) as never,
            ((overlay?.water?.features ?? []) as never) ?? [],
            [...(merged.DEPARE?.features ?? []), ...(merged.DRGARE?.features ?? [])] as never,
        );
        (merged.BOYLAT!.features as unknown[]).push(...midpoints);
        (merged.FAIRWY!.features as unknown[]).push(...segments);
        const oriented = orientHazardsTowardLand(hazards as never, (merged.LNDARE?.features ?? []) as never);
        (merged.OBSTRN!.features as unknown[]).push(...(oriented as unknown[]), ...wings);
    } catch {
        console.log('  (regional markers unavailable — chart+OSM only)');
    }
    return merged;
}

function describeRoute(label: string, r: RouteResult): void {
    let routeM = 0;
    for (let i = 1; i < r.polyline.length; i++) routeM += distM(r.polyline[i - 1], r.polyline[i]);
    console.log(`\n== ${label} ==`);
    console.log(
        `  ${r.distanceNM.toFixed(2)} NM  |  caution ${(r.cautionMask ?? []).filter(Boolean).length}/${(r.cautionMask ?? []).length} segs  |  shallowRuns ${(r.shallowRuns ?? []).length}`,
    );
    for (const run of r.shallowRuns ?? []) {
        console.log(
            `    · run ${(run.lengthM / 1852).toFixed(2)} NM  minDepth ${run.minDepthM === null ? 'uncharted' : run.minDepthM.toFixed(1) + ' m'}  @ ${run.minAtLat?.toFixed(4)},${run.minAtLon?.toFixed(4)}  (mid ${run.midLat.toFixed(4)},${run.midLon.toFixed(4)})`,
        );
    }
}

async function printWindows(
    label: string,
    r: RouteResult,
    draftM: number,
    fromMs: number,
    untilMs: number,
): Promise<void> {
    // Every charted gate on the route, including drying (the honest "not at
    // your draft, any tide" verdicts belong in the plan too).
    const runs = (r.shallowRuns ?? []).filter((x) => x.minDepthM !== null);
    if (runs.length === 0) return;
    const anchor = runs.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
    const curve = await fetchTideCurve(anchor.midLat, anchor.midLon, fromMs, untilMs);
    if (!curve) {
        console.log(`  [${label}] tide curve unavailable in this environment — check windows on the device`);
        return;
    }
    const tide = tideFieldFromCurve(curve);
    for (const run of runs) {
        const res = computeTidalWindows({
            minDepthM: run.minDepthM as number,
            draftM,
            tideSafetyM: 0.5,
            tide,
            fromMs,
            untilMs,
        });
        const windows = res.windows
            .map(
                (w) =>
                    `${new Date(w.openMs).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}–${new Date(w.closeMs).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}${w.approx ? '≈' : ''}`,
            )
            .join(', ');
        console.log(
            `  [${label}] bank @${run.midLat.toFixed(4)},${run.midLon.toFixed(4)} (${run.minDepthM?.toFixed(1)} m charted): needs +${res.requiredRiseM.toFixed(1)} m above LAT — ${res.alwaysOpen ? 'open at all tides' : windows || 'NO WINDOW in range'} (via ${curve.stationName ?? 'station'})`,
        );
    }
}

describe('Serene Summer homecoming — Mooloolaba → Newport', () => {
    it('prints the three-variant passage plan with tomorrow tide windows', async () => {
        if (!PI_UP) {
            console.log('SKIP — Pi unreachable');
            return;
        }
        const draftM = 2.4;
        // Tomorrow 04:00 → 22:00 local.
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 4, 0, 0).getTime();
        const until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 22, 0, 0).getTime();
        console.log(`\nPASSAGE PLAN window: ${new Date(from).toString()} → ${new Date(until).toString()}`);

        const layers = await assemble(MOOLOOLABA_WHARF, NEWPORT_CHANNEL);
        const req = {
            fromLat: MOOLOOLABA_WHARF[1],
            fromLon: MOOLOOLABA_WHARF[0],
            toLat: NEWPORT_CHANNEL[1],
            toLon: NEWPORT_CHANNEL[0],
            draftM,
            safetyM: 0.5,
            resolutionM: 50,
            unchartedPolicy: 'strict' as const,
        };

        // A) SAFEST
        const safest = routeInshore(layers, req);
        if ('error' in safest) console.log(`SAFEST REFUSED: ${safest.error}`);
        else {
            describeRoute('A · SAFEST (default profile)', safest);
            await printWindows('A', safest, draftM, from, until);
        }

        // B) SHORTEST (tideAssist)
        const shortest = routeInshore(layers, { ...req, routeProfile: 'tideAssist' });
        if ('error' in shortest) console.log(`SHORTEST REFUSED: ${shortest.error}`);
        else {
            describeRoute('B · SHORTEST (tide-assist profile — Gilligans Island bank)', shortest);
            await printWindows('B', shortest, draftM, from, until);
        }

        // C) VIA PEARL CHANNEL — three-leg stitch down the probed 153.22 spine.
        const legDefs: [[number, number], [number, number]][] = [
            [MOOLOOLABA_WHARF, PEARL_N],
            [PEARL_N, PEARL_S],
            [PEARL_S, NEWPORT_CHANNEL],
        ];
        const legs: RouteResult[] = [];
        let legFail: string | null = null;
        for (const [a, b] of legDefs) {
            const lr = routeInshore(layers, { ...req, fromLat: a[1], fromLon: a[0], toLat: b[1], toLon: b[0] });
            if ('error' in lr) {
                legFail = `${a} → ${b}: ${lr.error}`;
                break;
            }
            legs.push(lr);
        }
        if (legFail) {
            console.log(`PEARL CHANNEL variant failed: ${legFail}`);
        } else {
            const stitched: RouteResult = {
                ...legs[legs.length - 1],
                polyline: legs.reduce<[number, number][]>(
                    (acc, l, i) => [...acc, ...(i === 0 ? l.polyline : l.polyline.slice(1))],
                    [],
                ),
                distanceNM: legs.reduce((s, l) => s + l.distanceNM, 0),
                cautionMask: legs.flatMap((l) => l.cautionMask ?? []),
                shallowRuns: legs.flatMap((l) => l.shallowRuns ?? []),
            };
            console.log(`  (legs: ${legs.map((l) => l.distanceNM.toFixed(1)).join(' + ')} NM)`);
            describeRoute('C · VIA PEARL CHANNEL (proper N-entry/S-exit)', stitched);
            await printWindows('C', stitched, draftM, from, until);
        }

        // D) DEVICE TWO-TAP CHECK — on the boat Shane taps Mooloolaba→PEARL_N,
        // then PEARL_N→Newport. Verify the second tap's FREE A* (no forced
        // PEARL_S via) still rides the spine south and rounds the banks,
        // instead of cutting across the drying Moreton Banks.
        const d2 = routeInshore(layers, {
            ...req,
            fromLat: PEARL_N[1],
            fromLon: PEARL_N[0],
            toLat: NEWPORT_CHANNEL[1],
            toLon: NEWPORT_CHANNEL[0],
        });
        if ('error' in d2) console.log(`TWO-TAP LEG REFUSED: ${d2.error}`);
        else {
            describeRoute('D · TWO-TAP: Pearl N entry → Newport (free A*)', d2);
            await printWindows('D', d2, draftM, from, until);
        }

        expect(true).toBe(true);
    }, 300_000);
});
