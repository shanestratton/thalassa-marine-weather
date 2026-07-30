/**
 * Newport-corridor SENC layers, from a committed fixture instead of the Pi.
 *
 * The land-crossing repro suites — the highest-consequence assertions in the
 * product, since a false pass here means a route over land — were all gated
 * behind `describe.skipIf(!PI_UP)`, where PI_UP was a `curl` to
 * calypso.local:3001. On a CI runner that host does not resolve, so every one
 * of them silently reported PASSED while executing nothing. They had not run in
 * CI since they were written.
 *
 * tests/fixtures/newport-enc-cells.json.gz holds the two cells they read
 * (OC-61-10ENB5 and OC-61-10RCS5), trimmed to ONLY the five layers they touch:
 * BCNLAT, BOYLAT, DEPARE, DRGARE, LNDARE. That is 1.65 MB of JSON, 370 KB
 * gzipped — against the 13 MB of corridor fixtures already committed here, a
 * small price for making the reef tests real.
 *
 * The fixture keeps the exact shape of the live
 * `/api/enc/installed/<id>/data` response, so refreshing it is a straight
 * re-capture with no reshaping. To refresh (needs the Pi on the LAN):
 *
 *   curl -s http://calypso.local:3001/api/enc/installed/OC-61-10ENB5/data -o /tmp/enb5.json
 *   curl -s http://calypso.local:3001/api/enc/installed/OC-61-10RCS5/data -o /tmp/rcs5.json
 *   # then keep only the five layers above and gzip to
 *   # tests/fixtures/newport-enc-cells.json.gz
 *
 * These are DERIVED extracts of licensed AU chart data, consistent with the
 * corridor fixtures already in this directory. If the licence terms ever
 * require otherwise, the fix is to synthesise equivalent geometry — not to
 * re-gate the tests on a host CI cannot reach.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Feature } from 'geojson';

interface EncCellFixture {
    cells: { cellId: string; layers: Record<string, { features: Feature[] }> }[];
}

let cached: EncCellFixture | null = null;

function fixture(): EncCellFixture {
    if (!cached) {
        const path = join(__dirname, '..', 'fixtures', 'newport-enc-cells.json.gz');
        cached = JSON.parse(gunzipSync(readFileSync(path)).toString()) as EncCellFixture;
    }
    return cached;
}

/**
 * Features for one S-57 layer of one cell.
 *
 * Throws on an unknown cell rather than returning [] — a silently empty layer
 * is how a land-crossing assertion passes without testing anything, which is
 * the exact failure these suites already had.
 */
export function encLayer(cellId: string, layerName: string): Feature[] {
    const cell = fixture().cells.find((c) => c.cellId === cellId);
    if (!cell) {
        const have = fixture()
            .cells.map((c) => c.cellId)
            .join(', ');
        throw new Error(`ENC fixture has no cell ${cellId} — it holds: ${have}`);
    }
    return cell.layers[layerName]?.features ?? [];
}

/**
 * The Pi's OSM overlay for a corridor, from a committed fixture.
 *
 * Same reason as the ENC cells: these suites curled
 * calypso.local:3001/api/osm/overlay, so on CI they skipped silently.
 *
 * Refresh (needs the Pi on the LAN) — the bbox is the one the suite passes:
 *   curl -s 'http://calypso.local:3001/api/osm/overlay?bbox=<bbox>' -o out.json
 *   # then gzip to tests/fixtures/<name>.json.gz
 */
export function osmOverlay(name: 'newport-canal' | 'newport-pinkenba'): unknown {
    const path = join(__dirname, '..', 'fixtures', `${name}-osm.json.gz`);
    return JSON.parse(gunzipSync(readFileSync(path)).toString());
}

/** A whole cell (all layers), for suites that assemble many S-57 layers. */
export function encCell(cellId: string): { cellId: string; layers: Record<string, { features: Feature[] }> } {
    const cell = fixture().cells.find((c) => c.cellId === cellId);
    if (!cell) throw new Error(`ENC fixture has no cell ${cellId}`);
    return cell;
}

/**
 * The curated SE-QLD regional nav-marker file, normally fetched from Supabase
 * public storage at run time. Committed so the repro suite does not depend on an
 * external service being up for CI to be meaningful.
 */
export function seQldNavMarkers(): unknown {
    const path = join(__dirname, '..', 'fixtures', 'se-qld-nav-markers.json.gz');
    return JSON.parse(gunzipSync(readFileSync(path)).toString());
}

/** Cell ids in the fixture, for tests that want to assert coverage. */
export function encCellIds(): string[] {
    return fixture().cells.map((c) => c.cellId);
}
