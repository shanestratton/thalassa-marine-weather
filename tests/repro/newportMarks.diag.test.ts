/**
 * DIAGNOSTIC — why do fairlead + followChannelGates DECLINE on the real Newport
 * exit channel (so the span falls to the hugging `astar`)?
 *
 * Runs the REAL fairlead functions against the REAL chart beacons (rcs5 + enb5,
 * curl'd to /tmp by the repro harness) and reports the channel reconstruction:
 * mark count + port/stbd split, groupChannels output (key:size), and the
 * corridorCenterline for the Newport-exit channel. Skips without the Pi.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { Feature } from 'geojson';
import { parseLateralMarks, groupChannels, corridorCenterline, distM, type LateralMark } from '../../services/fairlead';

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
function loadMarks(path: string, id: string): Feature[] {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as {
        cells: { cellId: string; layers: Record<string, { features: Feature[] }> }[];
    };
    const cell = blob.cells.find((c) => c.cellId === id) ?? blob.cells[0];
    return [...(cell.layers['BOYLAT']?.features ?? []), ...(cell.layers['BCNLAT']?.features ?? [])];
}

describe.skipIf(!PI_UP)('Newport marks — fairlead reconstruction diagnostic', () => {
    it('reports why the Newport-exit channel does/does not reconstruct', () => {
        ensure('OC-61-10ENB5', '/tmp/enb5.json');
        ensure('OC-61-10RCS5', '/tmp/rcs5.json');
        const feats = [...loadMarks('/tmp/enb5.json', 'OC-61-10ENB5'), ...loadMarks('/tmp/rcs5.json', 'OC-61-10RCS5')];
        const marks = parseLateralMarks(feats as never);

        // Newport-exit marks: lat -27.214..-27.16, lon 153.085..153.11.
        const exit = marks.filter((m) => m.lat > -27.214 && m.lat < -27.16 && m.lon > 153.085 && m.lon < 153.11);
        const port = exit.filter((m) => m.side === 'port');
        const stbd = exit.filter((m) => m.side === 'stbd');

        console.log(
            `\nPARSED marks total=${marks.length}  exit-area=${exit.length} (port=${port.length} stbd=${stbd.length})`,
        );

        console.log(
            'exit keys:',
            JSON.stringify([...new Set(exit.map((m) => `${m.key}:${m.seq}:${m.side[0]}`))].slice(0, 30)),
        );

        const channels = groupChannels(marks);

        console.log(`\ngroupChannels → ${channels.length} channels:`);
        for (const ch of channels) {
            const p = ch.filter((m) => m.side === 'port').length;
            const s = ch.filter((m) => m.side === 'stbd').length;
            const lats = ch.map((m) => m.lat);
            const inExit = ch.some((m) => m.lat > -27.214 && m.lat < -27.16 && m.lon > 153.085 && m.lon < 153.11);

            console.log(
                `  key=${ch[0].key} n=${ch.length} (p=${p}/s=${s}) latRange=[${Math.min(...lats).toFixed(3)},${Math.max(
                    ...lats,
                ).toFixed(3)}]${inExit ? '  <== NEWPORT EXIT' : ''}`,
            );
        }

        // For each channel that includes the exit, build the centreline + measure wander.
        for (const ch of channels) {
            const inExit = ch.some((m) => m.lat > -27.214 && m.lat < -27.16 && m.lon > 153.085 && m.lon < 153.11);
            if (!inExit) continue;
            const centre = corridorCenterline(ch, 140);
            // wander = max step-to-step turn; a clean channel centreline is monotone.
            let maxTurnDeg = 0;
            for (let i = 1; i + 1 < centre.length; i++) {
                const a = centre[i - 1];
                const b = centre[i];
                const c = centre[i + 1];
                const b1 = Math.atan2(b.lat - a.lat, b.lon - a.lon);
                const b2 = Math.atan2(c.lat - b.lat, c.lon - b.lon);
                let d = Math.abs((b2 - b1) * (180 / Math.PI));
                if (d > 180) d = 360 - d;
                maxTurnDeg = Math.max(maxTurnDeg, d);
            }
            const valid = centre.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).length;

            console.log(
                `\ncorridorCenterline(key=${ch[0].key}) → ${centre.length} pts, ${valid} finite, maxTurn=${maxTurnDeg.toFixed(
                    0,
                )}°`,
            );
        }

        // Manual nearest-gate pairing (mirrors followChannelGates, grid-free part).
        const MAX_GATE_M = 500;
        let gateCount = 0;
        for (const p of port) {
            let bd = MAX_GATE_M;
            let best: LateralMark | null = null;
            for (const s of stbd) {
                const d = distM(p, s);
                if (d < bd) {
                    bd = d;
                    best = s;
                }
            }
            if (best) gateCount++;
        }

        console.log(`\nnearest-gate pairing (≤${MAX_GATE_M}m): ${gateCount} gates from ${port.length} port marks`);
        expect(marks.length).toBeGreaterThan(0);
    });
});
