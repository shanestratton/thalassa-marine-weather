/**
 * OFFLINE land-cross test for followChannelGates on the REAL Newport-exit marks.
 *
 * The Newport exit chart lumps TWO PARALLEL numbered channels (~1.1 km apart, both
 * numbered 2..10) under one 'NUM' key. The full-route harness can't exercise this
 * (it classes the exit tier-2), so this drives followChannelGates DIRECTLY with:
 *   • the REAL beacons (parseLateralMarks over the live rcs5+enb5 BOYLAT/BCNLAT), and
 *   • a REAL land grid (LNDARE rasterised into NavGrid.landBlocked at 50 m),
 * then asserts the returned channel centreline NEVER crosses land — the safety
 * property the device violated when the veto was relaxed. It also instruments the
 * gates + centreline so the failure is legible.
 *
 * Pre-fix expectation: a span that comes near BOTH channels makes the follower
 * interleave their gates → the centreline zigzags across the land between them →
 * (strict veto) declines, so it can't follow the channel at all. Post-fix: it
 * clusters to the ONE channel the span rides and returns a clean centreline.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson';
import { parseLateralMarks } from '../../services/fairlead';
import { followChannelGates } from '../../services/tier3/tier3Router';
import type { NavGrid } from '../../services/inshoreRouterEngine';

type LL = { lat: number; lon: number };

function piReachable(): boolean {
    try {
        execFileSync('curl', ['-s', '-f', '-m', '4', 'http://calypso.local:3001/api/enc/health'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
const PI_UP = piReachable();

function ensure(id: string, path: string): void {
    if (existsSync(path)) return;
    const out = execFileSync('curl', ['-s', '-f', `http://calypso.local:3001/api/enc/installed/${id}/data`], {
        maxBuffer: 64 * 1024 * 1024,
    });
    require('node:fs').writeFileSync(path, out);
}
function layer(path: string, id: string, name: string): Feature[] {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as {
        cells: { cellId: string; layers: Record<string, { features: Feature[] }> }[];
    };
    const cell = blob.cells.find((c) => c.cellId === id) ?? blob.cells[0];
    return (cell.layers[name]?.features ?? []) as Feature[];
}

// ── Grid build: rasterise the real LNDARE into landBlocked ──────────
const M_PER_LAT = 110_540;
function mPerLon(lat: number): number {
    return 111_320 * Math.cos((lat * Math.PI) / 180);
}
function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0],
            yi = ring[i][1];
        const xj = ring[j][0],
            yj = ring[j][1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
function inLandare(lon: number, lat: number, polys: Feature[]): boolean {
    for (const f of polys) {
        const g = f.geometry as Polygon | MultiPolygon | undefined;
        if (!g) continue;
        if (g.type === 'Polygon') {
            if (g.coordinates[0] && pointInRing(lon, lat, g.coordinates[0])) return true;
        } else if (g.type === 'MultiPolygon') {
            for (const poly of g.coordinates) if (poly[0] && pointInRing(lon, lat, poly[0])) return true;
        }
    }
    return false;
}
function buildGrid(
    bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number },
    lndare: Feature[],
): NavGrid {
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const dLat = 50 / M_PER_LAT;
    const dLon = 50 / mPerLon(midLat);
    const width = Math.ceil((bbox.maxLon - bbox.minLon) / dLon) + 1;
    const height = Math.ceil((bbox.maxLat - bbox.minLat) / dLat) + 1;
    const cells = new Float32Array(width * height).fill(10); // all deep — isolate the land veto
    const landBlocked = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const lon = bbox.minLon + (x + 0.5) * dLon;
            const lat = bbox.minLat + (y + 0.5) * dLat;
            if (inLandare(lon, lat, lndare)) landBlocked[y * width + x] = 1;
        }
    }
    return {
        width,
        height,
        minLon: bbox.minLon,
        minLat: bbox.minLat,
        dLon,
        dLat,
        cells,
        preferred: new Uint8Array(width * height),
        landBlocked,
    };
}
function onLand(grid: NavGrid, p: LL): boolean {
    const x = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y = Math.floor((p.lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
    return grid.landBlocked?.[y * grid.width + x] === 1;
}

const BBOX = { minLon: 153.082, minLat: -27.216, maxLon: 153.112, maxLat: -27.158 };

describe.skipIf(!PI_UP)('followChannelGates — Newport exit, two-parallel-channel land-cross', () => {
    it('follows ONE channel cleanly and never crosses land', () => {
        ensure('OC-61-10ENB5', '/tmp/enb5.json');
        ensure('OC-61-10RCS5', '/tmp/rcs5.json');
        const markFeats = [
            ...layer('/tmp/enb5.json', 'OC-61-10ENB5', 'BOYLAT'),
            ...layer('/tmp/enb5.json', 'OC-61-10ENB5', 'BCNLAT'),
            ...layer('/tmp/rcs5.json', 'OC-61-10RCS5', 'BOYLAT'),
            ...layer('/tmp/rcs5.json', 'OC-61-10RCS5', 'BCNLAT'),
        ];
        const marks = parseLateralMarks(markFeats as never);
        const lndare = [
            ...layer('/tmp/enb5.json', 'OC-61-10ENB5', 'LNDARE'),
            ...layer('/tmp/rcs5.json', 'OC-61-10RCS5', 'LNDARE'),
        ];
        const grid = buildGrid(BBOX, lndare);

        // The span = what coarse A* actually produces: a WATER-following path from
        // the marina exit up to the bay, weaving through the land maze (BFS over the
        // real land grid, 50 m cells). This is faithful — A* never crosses land — so
        // the ONLY way a land-cross enters is the gate-follower drawing a straight
        // stub from a span endpoint to the first/last gate across the maze.
        const cellOf = (p: LL): [number, number] => [
            Math.floor((p.lon - grid.minLon) / grid.dLon),
            Math.floor((p.lat - grid.minLat) / grid.dLat),
        ];
        const water = (x: number, y: number): boolean =>
            x >= 0 && y >= 0 && x < grid.width && y < grid.height && grid.landBlocked?.[y * grid.width + x] !== 1;
        const snapWater = (p: LL): [number, number] => {
            const [cx, cy] = cellOf(p);
            for (let r = 0; r < 30; r++)
                for (let dy = -r; dy <= r; dy++)
                    for (let dx = -r; dx <= r; dx++) if (water(cx + dx, cy + dy)) return [cx + dx, cy + dy];
            return [cx, cy];
        };
        const bfsWater = (from: LL, to: LL): LL[] => {
            const [sx, sy] = snapWater(from);
            const [gx, gy] = snapWater(to);
            const prev = new Int32Array(grid.width * grid.height).fill(-2);
            const q: number[] = [sy * grid.width + sx];
            prev[sy * grid.width + sx] = -1;
            let head = 0;
            while (head < q.length) {
                const cur = q[head++];
                if (cur === gy * grid.width + gx) break;
                const cx = cur % grid.width,
                    cy = Math.floor(cur / grid.width);
                for (const [dx, dy] of [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1],
                    [1, 1],
                    [1, -1],
                    [-1, 1],
                    [-1, -1],
                ]) {
                    const nx = cx + dx,
                        ny = cy + dy;
                    if (!water(nx, ny)) continue;
                    const ni = ny * grid.width + nx;
                    if (prev[ni] !== -2) continue;
                    prev[ni] = cur;
                    q.push(ni);
                }
            }
            const path: LL[] = [];
            let cur = gy * grid.width + gx;
            if (prev[cur] === -2) return [from, to]; // no water path — fall back
            while (cur !== -1) {
                const cx = cur % grid.width,
                    cy = Math.floor(cur / grid.width);
                path.push({ lat: grid.minLat + (cy + 0.5) * grid.dLat, lon: grid.minLon + (cx + 0.5) * grid.dLon });
                cur = prev[cur];
            }
            return path.reverse();
        };
        // Marina exit origin → up the bay past the WEST channel.
        const span: LL[] = bfsWater({ lat: -27.2125, lon: 153.0905 }, { lat: -27.182, lon: 153.095 });

        // ── Instrument: replicate the near-filter + gate-pairing + ordering so the
        //    decline is legible (gates from which channel, where land is crossed). ──
        const projAlongPerp = (p: LL): { along: number; perp: number } => {
            let bestPerp = Infinity,
                bestAlong = 0,
                cum = 0;
            for (let i = 0; i < span.length - 1; i++) {
                const a = span[i],
                    b = span[i + 1];
                const mLon = mPerLon(a.lat);
                const bx = (b.lon - a.lon) * mLon,
                    by = (b.lat - a.lat) * M_PER_LAT;
                const px = (p.lon - a.lon) * mLon,
                    py = (p.lat - a.lat) * M_PER_LAT;
                const segLen2 = bx * bx + by * by || 1;
                const t = Math.max(0, Math.min(1, (px * bx + py * by) / segLen2));
                const perp = Math.hypot(px - bx * t, py - by * t);
                const segLen = Math.hypot(bx, by);
                if (perp < bestPerp) {
                    bestPerp = perp;
                    bestAlong = cum + t * segLen;
                }
                cum += segLen;
            }
            return { along: bestAlong, perp: bestPerp };
        };
        const gM = (a: LL, b: LL): number => Math.hypot((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_LAT);
        const near = marks.filter((m) => projAlongPerp(m).perp < 500);
        const nport = near.filter((m) => m.side === 'port');
        const nstbd = near.filter((m) => m.side === 'stbd');
        const gates = nport
            .map((p) => {
                let best: LL | null = null,
                    bd = 500;
                for (const s of nstbd) {
                    const d = gM(p, s);
                    if (d < bd) {
                        bd = d;
                        best = s;
                    }
                }
                return best ? { mid: { lat: (p.lat + best.lat) / 2, lon: (p.lon + best.lon) / 2 }, p, s: best } : null;
            })
            .filter(Boolean) as { mid: LL; p: LL; s: LL }[];
        gates.sort((a, b) => projAlongPerp(a.mid).along - projAlongPerp(b.mid).along);
        // eslint-disable-next-line no-console
        console.log(`\nnear marks: ${near.length} (port=${nport.length} stbd=${nstbd.length}); gates (along order):`);
        for (const g of gates)
            // eslint-disable-next-line no-console
            console.log(
                `   gate mid lat=${g.mid.lat.toFixed(4)} lon=${g.mid.lon.toFixed(4)} ${
                    onLand(grid, g.mid) ? 'ON-LAND' : ''
                } (port lon ${g.p.lon.toFixed(4)} ↔ stbd lon ${g.s.lon.toFixed(4)}, width ${gM(g.p, g.s).toFixed(0)}m)`,
            );
        // Sample the OLD pre-splice centreline ([sub[0], …mids, sub[end]] — straight
        // stubs) for land crossings, to document WHY it failed. The fixed function
        // splices the gates into the A* sub instead (asserted below).
        // eslint-disable-next-line no-console
        console.log('pre-splice straight-stub land crossings (the bug):');
        const chain = [span[0], ...gates.map((g) => g.mid), span[span.length - 1]];
        for (let i = 0; i < chain.length - 1; i++) {
            const a = chain[i],
                b = chain[i + 1];
            const steps = Math.max(1, Math.ceil(gM(a, b) / 25));
            const hits: string[] = [];
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const q = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
                if (onLand(grid, q)) hits.push(`${q.lat.toFixed(4)},${q.lon.toFixed(4)}`);
            }
            if (hits.length)
                // eslint-disable-next-line no-console
                console.log(
                    `   seg ${i} (${i === 0 ? 'ENTRY' : i === chain.length - 2 ? 'EXIT' : 'body'}) crosses land ×${hits.length}: ${hits[0]}…${hits[hits.length - 1]}`,
                );
        }

        let declineReason = '';
        const centre = followChannelGates(span, marks, grid, (r) => {
            declineReason = r;
        });

        // eslint-disable-next-line no-console
        console.log(`\nfollowChannelGates → ${centre ? `${centre.length} pts` : `null (decline=${declineReason})`}`);
        if (centre) {
            const crossings = centre.filter((p) => onLand(grid, p));
            const lons = centre.map((p) => p.lon);
            let maxJumpM = 0;
            for (let i = 1; i < centre.length; i++) {
                const dM = Math.abs(centre[i].lon - centre[i - 1].lon) * mPerLon(centre[i].lat);
                maxJumpM = Math.max(maxJumpM, dM);
            }
            // eslint-disable-next-line no-console
            console.log(
                `centre lon range=[${Math.min(...lons).toFixed(4)},${Math.max(...lons).toFixed(4)}] ` +
                    `maxEastWestJump=${maxJumpM.toFixed(0)}m landCrossings=${crossings.length}`,
            );
            for (const p of centre.slice(0, 40))
                // eslint-disable-next-line no-console
                console.log(`   ${onLand(grid, p) ? 'LAND ' : '     '}lat=${p.lat.toFixed(4)} lon=${p.lon.toFixed(4)}`);
        }

        // SAFETY (the device violation): the followed centreline must never cross land.
        expect(centre, `gate-follower declined (${declineReason}) instead of following one channel`).not.toBeNull();
        if (centre) {
            const crossings = centre.filter((p) => onLand(grid, p));
            expect(crossings.length, 'centreline crosses land (interleaved the two parallel channels)').toBe(0);
            // Followed ONE channel: no >600 m east-west jump between consecutive points
            // (a jump that size = hopping to the parallel channel across the mudbank).
            for (let i = 1; i < centre.length; i++) {
                const jumpM = Math.abs(centre[i].lon - centre[i - 1].lon) * mPerLon(centre[i].lat);
                expect(jumpM, `inter-point E-W jump at ${i} hops between the parallel channels`).toBeLessThan(600);
            }
        }
    });
});
