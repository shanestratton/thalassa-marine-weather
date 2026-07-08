/**
 * BAY SWEEP — the "better than Navionics" validation grind (carte blanche #1).
 *
 * Routes the classic Moreton Bay / SE-QLD passages against the REAL installed
 * ENC cells (live from the boat's chart server) and prints, per passage:
 *   verdict | distance + efficiency ratio | depth-band occupancy |
 *   HARD-LAND crossings | shallow runs (keel margin) | compute ms
 *
 * Chart-only harness (no OSM overlay / regional markers / injected water —
 * the engine core on chart truth; the device adds enrichment on top). Cells
 * are merged with the SAME scale-shadow rule as the live orchestrator so the
 * Coral Sea overview cell can't paint land over the bay.
 *
 * Diagnostic by design: passages report, they don't abort the sweep. Locks
 * come after fixes, one per class, per house rules.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx vitest run tests/repro/baySweep.diag.test.ts
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Position } from 'geojson';
import { routeInshore, type InshoreLayers } from '../../services/inshoreRouterEngine';
import { shadowingCells, featureIsShadowed } from '../../services/enc/scaleShadow';

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
const CACHE_DIR = '/tmp/baySweepCells';

interface PassageDef {
    name: string;
    from: [number, number]; // [lon, lat]
    to: [number, number];
}

// The classics. Endpoints on water, inside installed coverage.
const PASSAGES: PassageDef[] = [
    { name: 'Newport → Pinkenba', from: [153.0879, -27.2127], to: [153.1176, -27.4325] },
    { name: 'Newport → Tangalooma', from: [153.0879, -27.2127], to: [153.3705, -27.1772] },
    { name: 'Manly → Tangalooma', from: [153.1907, -27.4519], to: [153.3705, -27.1772] },
    { name: 'Manly → Horseshoe Bay (Peel)', from: [153.1907, -27.4519], to: [153.3529, -27.4986] },
    { name: 'Manly → Dunwich', from: [153.1907, -27.4519], to: [153.3982, -27.4972] },
    { name: 'Rivergate → Manly', from: [153.1027, -27.4437], to: [153.1907, -27.4519] },
    { name: 'Scarborough → Bribie (Bongaree)', from: [153.1093, -27.1929], to: [153.1568, -27.0857] },
    { name: 'Scarborough → Mooloolaba', from: [153.1093, -27.1929], to: [153.1279, -26.6885] },
    { name: 'Tangalooma → Mooloolaba', from: [153.3705, -27.1772], to: [153.1279, -26.6885] },
    { name: 'Caloundra → Mooloolaba', from: [153.1455, -26.8055], to: [153.1279, -26.6885] },
    { name: 'Cleveland → Coochiemudlo', from: [153.3092, -27.5147], to: [153.3266, -27.5665] },
    { name: 'Seaway → Paradise Point', from: [153.4292, -27.9381], to: [153.3963, -27.8886] },
];

interface CellMeta {
    cellId: string;
    bbox: [number, number, number, number];
}

type RawCell = { cellId: string; bbox: number[]; layers: Record<string, FeatureCollection> };

function listInstalled(): CellMeta[] {
    const out = execFileSync('curl', ['-s', '-f', '-m', '10', PI], { maxBuffer: 8 * 1024 * 1024 }).toString();
    const parsed = JSON.parse(out) as { cells?: CellMeta[] } | CellMeta[];
    const cells = Array.isArray(parsed) ? parsed : (parsed.cells ?? []);
    // Skip the US test cell + the local test blob.
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
                {
                    maxBuffer: 128 * 1024 * 1024,
                },
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

function corridorBbox(p: PassageDef, padDeg = 0.08): [number, number, number, number] {
    return [
        Math.min(p.from[0], p.to[0]) - padDeg,
        Math.min(p.from[1], p.to[1]) - padDeg,
        Math.max(p.from[0], p.to[0]) + padDeg,
        Math.max(p.from[1], p.to[1]) + padDeg,
    ];
}

const bboxIntersects = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Mirror the live orchestrator's merge incl. scale-shadow filtering. */
function assembleLayers(passage: PassageDef, installed: CellMeta[]): { layers: InshoreLayers; cells: string[] } {
    const bbox = corridorBbox(passage);
    const candidates = installed.filter((c) => bboxIntersects(bbox, c.bbox as [number, number, number, number]));
    const extents = candidates.map((c) => ({ id: c.cellId, bbox: c.bbox as [number, number, number, number] }));
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
    const used: string[] = [];
    for (const c of candidates) {
        const raw = fetchCell(c.cellId);
        if (!raw) continue;
        used.push(c.cellId);
        const shadows = shadowingCells({ id: c.cellId, bbox: c.bbox as [number, number, number, number] }, extents);
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
    return { layers: merged, cells: used };
}

// ── DEVICE-FAITHFUL enrichment (v2): Pi OSM overlay + SE-QLD regional markers ──
// Mirrors InshoreRouter's live merge so the sweep measures what the DEVICE
// routes on — the v1 chart-only run read the Brisbane River as land (91%
// "hard land" on Rivergate→Manly) purely because the LNDARE-bleed rescue
// lives in this enrichment, not in the chart.

type AnyFeature = Feature & { properties?: Record<string, unknown> | null };

function fetchOsmOverlay(bbox: [number, number, number, number]): Record<string, FeatureCollection> | null {
    // Retry ×3 and refuse an all-empty payload: the Pi answered the Bribie
    // corridor with rich data on a direct probe (water 286, canal 48) after the
    // sweep had silently accepted an empty response — a transient hiccup must
    // read as UNAVAILABLE, never as "no OSM data here".
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

/** Crude min-dimension width test standing in for the device's polygon probe. */
function bboxMinDimM(f: AnyFeature): number {
    let minLon = Infinity,
        minLat = Infinity,
        maxLon = -Infinity,
        maxLat = -Infinity;
    const visit = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            minLon = Math.min(minLon, c[0] as number);
            maxLon = Math.max(maxLon, c[0] as number);
            minLat = Math.min(minLat, c[1] as number);
            maxLat = Math.max(maxLat, c[1] as number);
            return;
        }
        for (const x of c) visit(x);
    };
    visit((f.geometry as { coordinates?: unknown } | null)?.coordinates);
    if (!Number.isFinite(minLon)) return 0;
    const midLat = (minLat + maxLat) / 2;
    return Math.min((maxLon - minLon) * mPerLon(midLat), (maxLat - minLat) * M_PER_LAT);
}

async function applyDeviceEnrichment(
    merged: InshoreLayers,
    passage: PassageDef,
): Promise<{ osmWater: AnyFeature[]; tags: string[] }> {
    const tags: string[] = [];
    const bbox = corridorBbox(passage);
    const overlay = fetchOsmOverlay(bbox);
    let osmWater: AnyFeature[] = [];
    if (overlay) {
        const push = (layer: keyof InshoreLayers, feats: unknown[]) =>
            (merged[layer]!.features as unknown[]).push(...feats);
        const water = (overlay.water?.features ?? []) as AnyFeature[];
        osmWater = water;
        // water → DEPARE (synthetic 10 m) + wide river/harbour promotion → FAIRWY.
        push(
            'DEPARE',
            water.map((f) => ({ ...f, properties: { ...(f.properties ?? {}), DRVAL1: 10.0, DRVAL2: 10.0 } })),
        );
        const promoted = water.filter((f) => {
            const p = (f.properties ?? {}) as Record<string, unknown>;
            const tagged =
                p['water'] === 'river' ||
                p['water'] === 'harbour' ||
                p['waterway'] === 'river' ||
                p['waterway'] === 'riverbank' ||
                p['harbour'] === 'yes';
            return tagged && bboxMinDimM(f) >= 200;
        });
        push(
            'FAIRWY',
            promoted.map((f) => ({
                ...f,
                properties: { ...(f.properties ?? {}), _promotePreferred: true, _source: 'osm-water-promoted' },
            })),
        );
        push(
            'DEPARE',
            ((overlay.marina?.features ?? []) as AnyFeature[]).map((f) => ({
                ...f,
                properties: { ...(f.properties ?? {}), DRVAL1: 5.0, DRVAL2: 5.0 },
            })),
        );
        push(
            'OBSTRN',
            ((overlay.reef?.features ?? []) as AnyFeature[]).map((f) => ({
                ...f,
                properties: { ...(f.properties ?? {}), _class: 'osm-reef' },
            })),
        );
        for (const f of (overlay.breakwater?.features ?? []) as AnyFeature[]) {
            const t = f.geometry?.type;
            if (t === 'Polygon' || t === 'MultiPolygon') push('LNDARE', [f]);
            else if (t === 'LineString' || t === 'MultiLineString') push('COASTLINE', [f]);
        }
        push(
            'OBSTRN',
            ((overlay.aeroway?.features ?? []) as AnyFeature[])
                .filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
                .map((f) => ({ ...f, properties: { ...(f.properties ?? {}), _class: 'osm-aeroway' } })),
        );
        push('COASTLINE', (overlay.coastline?.features ?? []) as unknown[]);
        push('CANAL', (overlay.canalLines?.features ?? []) as unknown[]);
        push('NAVLINE', (overlay.navLines?.features ?? []) as unknown[]);
        tags.push(
            `osm(w${water.length},prom${promoted.length},canal${overlay.canalLines?.features?.length ?? 0},nav${overlay.navLines?.features?.length ?? 0})`,
        );
    } else {
        tags.push('osm-overlay-UNAVAILABLE');
    }

    // SE-QLD regional markers (midpoints/segments/hazards/wings) — device path.
    const SEQ: [number, number, number, number] = [152.0, -28.5, 154.5, -26.0];
    const inSeq = (pnt: [number, number]) =>
        pnt[0] >= SEQ[0] && pnt[0] <= SEQ[2] && pnt[1] >= SEQ[1] && pnt[1] <= SEQ[3];
    if (inSeq(passage.from) && inSeq(passage.to)) {
        try {
            const { fetchRegionalMarkers, orientHazardsTowardLand, encLateralsFromFeatures } =
                await import('../../services/InshoreRouter');
            const url =
                'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/regions/australia_se_qld/nav_markers.geojson';
            const { midpoints, segments, hazards, wings } = await fetchRegionalMarkers(
                url,
                (merged.LNDARE?.features ?? []) as never,
                osmWater as never,
                [...(merged.DEPARE?.features ?? []), ...(merged.DRGARE?.features ?? [])] as never,
                // Device-faithful ENC lateral fold.
                encLateralsFromFeatures([
                    ...(merged.BCNLAT?.features ?? []),
                    ...(merged.BOYLAT?.features ?? []),
                ] as never),
            );
            (merged.BOYLAT!.features as unknown[]).push(...midpoints);
            (merged.FAIRWY!.features as unknown[]).push(...segments);
            const oriented = orientHazardsTowardLand(hazards as never, (merged.LNDARE?.features ?? []) as never);
            (merged.OBSTRN!.features as unknown[]).push(...(oriented as unknown[]), ...wings);
            tags.push(`markers(mid${midpoints.length},seg${segments.length},haz${hazards.length})`);
        } catch (err) {
            tags.push(`markers-FAILED(${err instanceof Error ? err.message.slice(0, 40) : 'err'})`);
        }
    }
    return { osmWater, tags };
}

// ── Metrics ──────────────────────────────────────────────────────────
const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);
const distM = (a: Position, b: Position): number =>
    Math.hypot((b[0] - a[0]) * mPerLon((a[1] + b[1]) / 2), (b[1] - a[1]) * M_PER_LAT);

function ptInRing(lon: number, lat: number, ring: number[][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function ptInAny(lon: number, lat: number, polys: (Polygon | MultiPolygon)[]): boolean {
    for (const g of polys) {
        const sets = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const rings of sets) {
            if (rings[0] && ptInRing(lon, lat, rings[0] as number[][])) {
                // Respect holes (ring 0 = outer; 1+ = holes).
                let inHole = false;
                for (let h = 1; h < rings.length; h++) {
                    if (ptInRing(lon, lat, rings[h] as number[][])) {
                        inHole = true;
                        break;
                    }
                }
                if (!inHole) return true;
            }
        }
    }
    return false;
}

const polysOf = (fc: FeatureCollection | undefined): (Polygon | MultiPolygon)[] =>
    (fc?.features ?? [])
        .map((f: Feature) => f.geometry)
        .filter((g): g is Polygon | MultiPolygon => !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon'));

describe('BAY SWEEP — classic passages vs real cells', () => {
    it('routes every passage and prints the scorecard', async () => {
        if (!PI_UP) {
            console.log('SKIP — Pi unreachable');
            return;
        }
        const installed = listInstalled();
        console.log(`\ninstalled OC cells: ${installed.length}`);
        const rows: string[] = [];
        for (const p of PASSAGES) {
            const t0 = Date.now();
            let row = `\n### ${p.name}`;
            try {
                const { layers, cells } = assembleLayers(p, installed);
                const { osmWater, tags } = await applyDeviceEnrichment(layers, p);
                row += `  {${tags.join(' ')}}`;
                const lnd = polysOf(layers.LNDARE);
                const wet = [
                    ...polysOf(layers.DEPARE),
                    ...polysOf(layers.DRGARE),
                    ...polysOf(layers.FAIRWY),
                    ...(osmWater
                        .map((f) => f.geometry)
                        .filter(
                            (g): g is Polygon | MultiPolygon =>
                                !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon'),
                        ) ?? []),
                ];
                const r = routeInshore(layers, {
                    fromLat: p.from[1],
                    fromLon: p.from[0],
                    toLat: p.to[1],
                    toLon: p.to[0],
                    draftM: 2.4,
                    safetyM: 0.5,
                    resolutionM: 50,
                    unchartedPolicy: 'strict',
                });
                const ms = Date.now() - t0;
                if ('error' in r) {
                    row += `\n  REFUSED (${r.code ?? 'no-code'}): ${r.error}  [${ms} ms, cells=${cells.join(',')}]`;
                } else {
                    // Efficiency
                    let routeM = 0;
                    for (let i = 1; i < r.polyline.length; i++) routeM += distM(r.polyline[i - 1], r.polyline[i]);
                    const directM = distM(r.polyline[0], r.polyline[r.polyline.length - 1]);
                    // Hard-land crossings: sampled point inside LNDARE with NO wet vouch.
                    let hardLand = 0;
                    let samples = 0;
                    for (let i = 1; i < r.polyline.length; i++) {
                        const segM = distM(r.polyline[i - 1], r.polyline[i]);
                        const steps = Math.max(1, Math.ceil(segM / 60));
                        for (let s = 0; s < steps; s++) {
                            const t = s / steps;
                            const lon = r.polyline[i - 1][0] + (r.polyline[i][0] - r.polyline[i - 1][0]) * t;
                            const lat = r.polyline[i - 1][1] + (r.polyline[i][1] - r.polyline[i - 1][1]) * t;
                            samples++;
                            if (ptInAny(lon, lat, lnd) && !ptInAny(lon, lat, wet)) hardLand++;
                        }
                    }
                    const runs = r.shallowRuns ?? [];
                    row +=
                        `\n  OK ${r.distanceNM.toFixed(2)} NM  ratio ${(routeM / Math.max(1, directM)).toFixed(3)}` +
                        `  hardLand ${hardLand}/${samples}` +
                        `  shallowRuns ${runs.length} [${runs.map((x) => (x.minDepthM === null ? '∅' : x.minDepthM.toFixed(1))).join(',')}]` +
                        `  caution ${(r.cautionMask ?? []).filter(Boolean).length}/${(r.cautionMask ?? []).length} segs` +
                        `  [${ms} ms, cells=${cells.join(',')}]`;
                }
            } catch (err) {
                row += `\n  THREW: ${err instanceof Error ? err.message : String(err)}`;
            }
            rows.push(row);
            console.log(row);
        }
        console.log('\n=== SWEEP COMPLETE ===');
        expect(rows.length).toBe(PASSAGES.length);
        // 300s cap like the sibling long diags (mooloolabaHomecoming,
        // tangaloomaLeads) — the 12-passage sweep runs ~110s with the Pi
        // up, and the suite-wide 20s default was failing it on time alone.
    }, 300_000);
});
