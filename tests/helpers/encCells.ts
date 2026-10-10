/**
 * Newport-corridor SENC layers, formerly from a committed fixture.
 *
 * tests/fixtures/newport-enc-cells.json.gz held two o-charts cells
 * (OC-61-10ENB5 and OC-61-10RCS5). It was a derived extract of licensed AU
 * chart data and was retired on 2026-10-10 under the o-charts ruling (127-C-a;
 * see ./retiredChartFixtures.ts), so encLayer, encCell and encCellIds now
 * throw: every suite that read them is gated and counted in
 * tests/retiredChartFixtures.ledger.test.ts until it is ported.
 *
 * Never re-capture a cell into tests/fixtures: build the geometry with the
 * synthetic harbour kit (tests/helpers/syntheticHarbour.ts, 127-C-a Phase 1)
 * or use a NOAA cell. The OSM overlay and nav-marker readers below are not
 * chart data and still work.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Feature } from 'geojson';
import { assertNotRetiredChartFixture } from './retiredChartFixtures';

interface EncCellFixture {
    cells: { cellId: string; layers: Record<string, { features: Feature[] }> }[];
}

let cached: EncCellFixture | null = null;

function fixture(): EncCellFixture {
    if (!cached) {
        assertNotRetiredChartFixture('newport-enc-cells.json.gz');
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
