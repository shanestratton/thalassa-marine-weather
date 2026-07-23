/**
 * Bench: followCanalLines on the REAL Newport canal lines (live OSM overlay from
 * calypso.local). Proves the centre-line follower routes the marina up the canal
 * (connected, rides the lines, no graph jumps) and declines off-network. Skips
 * without the Pi.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { Feature } from 'geojson';
import { followCanalLines, parseCanalLines } from '../../services/tier3/canalLineFollower';

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
    Math.hypot((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_LAT);

function piReachable(): boolean {
    try {
        execFileSync('curl', ['-s', '-f', '-m', '4', 'http://calypso.local:3001/api/enc/health'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
const PI_UP = piReachable();
const OSM = '/tmp/osm_full.json';
function ensureOsm(): void {
    if (existsSync(OSM)) return;
    const out = execFileSync(
        'curl',
        ['-s', '-f', 'http://calypso.local:3001/api/osm/overlay?bbox=153.082,-27.227,153.110,-27.198'],
        { maxBuffer: 64 * 1024 * 1024 },
    );
    require('node:fs').writeFileSync(OSM, out);
}

describe.skipIf(!PI_UP)('followCanalLines — Newport estate', () => {
    it('routes the marina up the canal centre-lines (connected, no jumps)', () => {
        ensureOsm();
        const d = JSON.parse(readFileSync(OSM, 'utf8')) as { canalLines?: { features: Feature[] } };
        const lines = parseCanalLines((d.canalLines?.features ?? []) as never);
        expect(lines.length).toBeGreaterThan(10);

        // marina berth → the canal mouth (the northern end of the line network,
        // where the canal meets the open channel; beyond is tier-2, not a canal).
        const route = followCanalLines({ lat: -27.2135, lon: 153.0875 }, { lat: -27.2043, lon: 153.0929 }, lines);
        expect(route, 'follower returned a route').not.toBeNull();
        if (!route) return;

        let len = 0;
        let maxSeg = 0;
        for (let i = 1; i < route.length; i++) {
            const seg = distM(route[i - 1], route[i]);
            len += seg;
            maxSeg = Math.max(maxSeg, seg);
        }
        // every interior point must ride a real canal-line vertex (≤ 5 m).
        const allVerts = lines.flat().map(([lon, lat]) => ({ lat, lon }));
        let maxOffLine = 0;
        for (const p of route.slice(1, -1)) {
            let best = Infinity;
            for (const v of allVerts) best = Math.min(best, distM(p, v));
            maxOffLine = Math.max(maxOffLine, best);
        }

        console.log(
            `route pts=${route.length} len=${len.toFixed(0)}m maxSeg=${maxSeg.toFixed(0)}m maxOffLine=${maxOffLine.toFixed(1)}m`,
        );

        expect(route.length).toBeGreaterThan(5);
        expect(len).toBeGreaterThan(500);
        expect(len).toBeLessThan(3000);
        // A real canal/main-channel can have a long straight run between OSM
        // vertices; only a >450 m hop would signal a bridged disconnect.
        expect(maxSeg, 'no large graph jump — the path stays on the lines').toBeLessThan(450);
        expect(maxOffLine, 'interior points ride the canal centre-lines exactly').toBeLessThan(5);
    });

    it('declines when the span is nowhere near a canal line', () => {
        ensureOsm();
        const d = JSON.parse(readFileSync(OSM, 'utf8')) as { canalLines?: { features: Feature[] } };
        const lines = parseCanalLines((d.canalLines?.features ?? []) as never);
        // open bay, kilometres from any Newport canal line.
        expect(followCanalLines({ lat: -27.3, lon: 153.3 }, { lat: -27.31, lon: 153.31 }, lines)).toBeNull();
    });
});
