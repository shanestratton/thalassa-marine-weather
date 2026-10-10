/**
 * capture-corridor-fixture — pull a NOAA ENC corridor from the Pi cache and
 * write a `noaa-<name>.corridor.json.gz` test fixture in the shape
 * tests/helpers/corridorFixture.ts (loadFixture/assembleLayers) expects:
 *
 *   { _meta, request, cells: Record<S57Class, FeatureCollection>, osm: {8 empty FCs} }
 *
 * NOAA cells ONLY (public domain). The repo is public, and licensed chart
 * data must never be written to any medium outside the chart provider's own
 * software (o-charts, 2026-10-10: "Storing unencrypted data on any medium,
 * and especially in the cloud, is strictly prohibited"). So every cell whose
 * id is not a NOAA id (US + usage band + five characters), or that the Pi
 * marks as not open, is refused and never fetched, and a feature from any
 * producer but "US" stops the capture. The real AU captures this tool once
 * wrote were retired on 2026-10-10 (127-C-a); tests/noProtectedChartData
 * fails CI on any that come back.
 *
 * OSM is left empty on purpose: the arbitration corpus isolates the
 * chart-mark graph, no OSM water promotion.
 *
 * Usage:
 *   node tools/capture-corridor-fixture.mjs \
 *     --name chesapeake-annapolis \
 *     --from 38.9718,-76.4810 --to 38.9500,-76.4300 \
 *     --draft 2.0 --safety 0.5 [--pi http://calypso.local:3001] [--pad 0.05]
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

/** A NOAA ENC cell id: US, a usage band 1-6, five letters or digits (e.g. US5MD1AM). */
const NOAA_CELL_ID = /^US[1-6][A-Z0-9]{5}$/;
/** Why a cell may not be captured, or null when it may. */
function refusal(cell) {
    if (!NOAA_CELL_ID.test(String(cell.cellId)))
        return 'not a NOAA cell (only public-domain NOAA ENCs may be captured)';
    const licence = cell.licence ?? cell.license;
    if (licence !== undefined && licence !== 'open') return `the Pi marks it ${licence}, not open`;
    return null;
}

const EMPTY_FC = () => ({ type: 'FeatureCollection', features: [] });
const OSM_KEYS = ['water', 'reef', 'coastline', 'marina', 'breakwater', 'aeroway', 'canalLines', 'navLines'];

async function main() {
    const bw = Math.min(fromLon, toLon) - pad;
    const be = Math.max(fromLon, toLon) + pad;
    const bs = Math.min(fromLat, toLat) - pad;
    const bn = Math.max(fromLat, toLat) + pad;

    const installed = await (await fetch(`${PI}/api/enc/installed`)).json();
    const overlapping = installed.cells.filter(
        (c) => c.bbox && c.bbox[0] <= be && c.bbox[2] >= bw && c.bbox[1] <= bn && c.bbox[3] >= bs,
    );
    const corridor = [];
    for (const c of overlapping) {
        const why = refusal(c);
        if (why) console.error(`refused ${c.cellId}: ${why}`);
        else corridor.push(c);
    }
    if (corridor.length === 0) throw new Error('no NOAA corridor cells overlap the request bbox');

    const cells = {};
    const editions = [];
    for (const c of corridor) {
        const data = await (await fetch(`${PI}/api/enc/installed/${c.cellId}/data`)).json();
        const cell = data.cells[0] ?? {};
        if (cell.sourceHO !== undefined && cell.sourceHO !== 'US')
            throw new Error(`${c.cellId} names producer ${cell.sourceHO}, not US: refusing the capture`);
        editions.push({
            cellId: c.cellId,
            edition: cell.edition ?? c.edition ?? null,
            update: cell.updateNumber ?? null,
        });
        for (const [k, fc] of Object.entries(cell.layers ?? {})) {
            cells[k] ??= { type: 'FeatureCollection', features: [] };
            for (const f of fc.features) {
                const ho = f.properties?.sourceHO;
                if (ho !== undefined && ho !== 'US')
                    throw new Error(`${c.cellId} ${k} carries producer ${ho}, not US: refusing the capture`);
                cells[k].features.push(f);
            }
        }
    }

    const markCount = (cells.BOYLAT?.features.length ?? 0) + (cells.BCNLAT?.features.length ?? 0);
    if (markCount === 0) throw new Error('captured corridor has NO lateral marks — wrong bbox or stale cells');

    const osm = Object.fromEntries(OSM_KEYS.map((k) => [k, EMPTY_FC()]));
    const fixture = {
        _meta: {
            source: 'NOAA ENC (US public domain) via the Pi, tools/capture-corridor-fixture.mjs',
            licence: 'public-domain',
            editions,
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
    const file = name.startsWith('noaa-') ? name : `noaa-${name}`;
    const out = join(__dirname, '..', 'tests', 'fixtures', `${file}.corridor.json.gz`);
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
