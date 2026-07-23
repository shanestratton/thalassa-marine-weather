/**
 * capture-corridor-fixture — pull a live ENC corridor from the Pi cache and
 * write a `.corridor.json.gz` test fixture in the shape tests/helpers/
 * corridorFixture.ts (loadFixture/assembleLayers) expects:
 *
 *   { _meta, request, cells: Record<S57Class, FeatureCollection>, osm: {8 empty FCs} }
 *
 * The golden corridor fixtures predate raw lateral-mark emission, so their
 * `cells` carry no BOYLAT/BCNLAT — useless for Seaway-Graph arbitration.
 * This captures fresh cells WITH marks. OSM is left empty on purpose: the
 * arbitration corpus isolates the chart-mark graph, no OSM water promotion.
 *
 * Usage:
 *   node tools/capture-corridor-fixture.mjs \
 *     --name newport-rivergate-marks \
 *     --from -27.2135,153.0875 --to -27.4268,153.1267 \
 *     --draft 2.4 --safety 0.2 [--pi http://calypso.local:3001] [--pad 0.1]
 */

import { Buffer } from 'node:buffer';

import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const name = arg('name');
const fromStr = arg('from');
const toStr = arg('to');
if (!name || !fromStr || !toStr) {
    console.error('required: --name --from lat,lon --to lat,lon');
    process.exit(1);
}
const [fromLat, fromLon] = fromStr.split(',').map(Number);
const [toLat, toLon] = toStr.split(',').map(Number);
const req = {
    fromLat,
    fromLon,
    toLat,
    toLon,
    draftM: Number(arg('draft', '2.4')),
    safetyM: Number(arg('safety', '0.2')),
};
const PI = arg('pi', 'http://calypso.local:3001');
const pad = Number(arg('pad', '0.1'));

const EMPTY_FC = () => ({ type: 'FeatureCollection', features: [] });
const OSM_KEYS = ['water', 'reef', 'coastline', 'marina', 'breakwater', 'aeroway', 'canalLines', 'navLines'];

async function main() {
    const bw = Math.min(fromLon, toLon) - pad;
    const be = Math.max(fromLon, toLon) + pad;
    const bs = Math.min(fromLat, toLat) - pad;
    const bn = Math.max(fromLat, toLat) + pad;

    const installed = await (await fetch(`${PI}/api/enc/installed`)).json();
    const corridor = installed.cells.filter(
        (c) =>
            c.cellId.startsWith('OC-') &&
            c.bbox &&
            c.bbox[0] <= be &&
            c.bbox[2] >= bw &&
            c.bbox[1] <= bn &&
            c.bbox[3] >= bs,
    );
    if (corridor.length === 0) throw new Error('no corridor cells overlap the request bbox');

    const cells = {};
    for (const c of corridor) {
        const data = await (await fetch(`${PI}/api/enc/installed/${c.cellId}/data`)).json();
        for (const [k, fc] of Object.entries(data.cells[0]?.layers ?? {})) {
            cells[k] ??= { type: 'FeatureCollection', features: [] };
            cells[k].features.push(...fc.features);
        }
    }

    const markCount = (cells.BOYLAT?.features.length ?? 0) + (cells.BCNLAT?.features.length ?? 0);
    if (markCount === 0) throw new Error('captured corridor has NO lateral marks — wrong bbox or stale cells');

    const osm = Object.fromEntries(OSM_KEYS.map((k) => [k, EMPTY_FC()]));
    const fixture = {
        _meta: {
            source: 'pi-cache live capture (tools/capture-corridor-fixture.mjs)',
            capturedAt: new Date().toISOString(),
            pi: PI,
            cells: corridor.map((c) => c.cellId),
            markCount,
            classCounts: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v.features.length])),
            note: 'OSM intentionally empty — arbitration isolates the chart-mark Seaway graph.',
        },
        request: req,
        cells,
        osm,
    };

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const out = join(__dirname, '..', 'tests', 'fixtures', `${name}.corridor.json.gz`);
    const gz = gzipSync(Buffer.from(JSON.stringify(fixture)), { level: 9 });
    writeFileSync(out, gz);
    console.log(`wrote ${out} (${(gz.length / 1024).toFixed(0)} KB)`);
    console.log(`cells: ${corridor.map((c) => c.cellId).join(' ')}`);
    console.log(`marks: BOYLAT=${cells.BOYLAT?.features.length ?? 0} BCNLAT=${cells.BCNLAT?.features.length ?? 0}`);
    console.log(`DEPARE=${cells.DEPARE?.features.length ?? 0} LNDARE=${cells.LNDARE?.features.length ?? 0}`);
}

main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
