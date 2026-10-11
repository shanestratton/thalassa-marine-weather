/**
 * The tracer's grid builds for the navGrid fold's parity test (127-ROUTE-W2).
 *
 * The tracer (services/routeTracer.ts) asks services/engine/navGridWorkerHost
 * for one depth grid per window: `buildNavGridAsync(layers, bbox,
 * tracerResolutionM(bbox), draftM, DEFAULT_TIDE_SAFETY_M, 60)`. Until 127 that
 * ran in its own worker (services/engine/navGridWorker.ts, a second copy of
 * the navGrid code); since the fold it runs in a second instance of the route
 * worker. These are the jobs both are given, built from the same synthetic
 * and NOAA scenes as the route job's goldens (tests/helpers/routeJobScenes.ts):
 * synthetic or NOAA US5GA22M (public domain) only. The NOAA case is null
 * without THALASSA_ENC_SAMPLES, and the test says why it skips.
 *
 * `gridDigest` is the grid as the main thread receives it, field by field: a
 * typed array by its kind, length and the sha256 of its bytes, so "the same
 * grid" means byte for byte; and which fields came back transferred.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { syntheticArchipelago, type LonLat } from '../fixtures/syntheticArchipelago';
import {
    canonicalJson,
    DRAFT_M,
    installAtlanticChannel,
    installNoaa,
    noaaCellPath,
    NOAA_ROUTE,
    scene,
    WRITE_GOLDENS,
} from './routeJobScenes';
import { tracerResolutionM } from '../../services/routeTracer';
import { DEFAULT_TIDE_SAFETY_M } from '../../services/routing/tidalWindow';
import type { InshoreLayers, NavGrid, RelaxZone } from '../../services/engine/types';

/** buildNavGrid's arguments, in its own order, as the tracer passes them. */
export interface TracerGridArgs {
    layers: InshoreLayers;
    bbox: [number, number, number, number];
    resolutionM: number;
    draftM: number;
    safetyM: number;
    obstructionBufferM: number;
    relaxedLndare: boolean;
    relaxZones: RelaxZone[];
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect';
}

const boxAround = (a: LonLat, b: LonLat, padDeg: number): [number, number, number, number] => [
    Math.min(a[0], b[0]) - padDeg,
    Math.min(a[1], b[1]) - padDeg,
    Math.max(a[0], b[0]) + padDeg,
    Math.max(a[1], b[1]) + padDeg,
];

/** Every cell's layers in one set (the tracer's merged bundle), with the OSM berths. */
function mergedArchipelago(): InshoreLayers {
    const a = syntheticArchipelago();
    const layers: Record<string, FeatureCollection> = {};
    for (const cell of a.cells)
        for (const [name, fc] of Object.entries(cell.blob.layers))
            (layers[name] ??= { type: 'FeatureCollection', features: [] }).features.push(...fc.features);
    layers.BERTH = a.osm.berths;
    return structuredClone(layers) as InshoreLayers;
}

function tracerArgs(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    extra: Partial<TracerGridArgs> = {},
) {
    return {
        layers,
        bbox,
        resolutionM: tracerResolutionM(bbox),
        draftM: DRAFT_M,
        safetyM: DEFAULT_TIDE_SAFETY_M,
        obstructionBufferM: 60,
        relaxedLndare: false,
        relaxZones: [],
        routeProfile: 'safest' as const,
        ...extra,
    } satisfies TracerGridArgs;
}

/** The cases, by golden name. NOAA's is a skip reason without the cell. */
export function tracerGridCases(): Record<string, TracerGridArgs | { skip: string }> {
    const routes = syntheticArchipelago().routes;
    const atlantic = installAtlanticChannel();
    const atlanticLayers = structuredClone(
        (scene.blobs.get('ZZ5ATL01') as { layers: InshoreLayers }).layers,
    ) as InshoreLayers;
    const noaa = noaaCellPath();
    return {
        // The tracer's own call, over the archipelago's 12 NM leg.
        'tracer-grid-archipelago-12nm': tracerArgs(
            mergedArchipelago(),
            boxAround(routes['12nm'].from, routes['12nm'].to, 0.02),
        ),
        // Every other argument the message carries, off its default.
        'tracer-grid-archipelago-5nm-relaxed': tracerArgs(
            mergedArchipelago(),
            boxAround(routes['5nm'].from, routes['5nm'].to, 0.01),
            {
                relaxedLndare: true,
                relaxZones: [{ lon: routes['5nm'].to[0], lat: routes['5nm'].to[1], radiusM: 400 }],
                routeProfile: 'tideAssist',
            },
        ),
        // A buoyed channel in the open North Atlantic.
        'tracer-grid-atlantic-channel': tracerArgs(atlanticLayers, boxAround(atlantic.from, atlantic.to, 0.01)),
        // NOAA US5GA22M, the Savannah River leg.
        'tracer-grid-noaa':
            'skip' in noaa
                ? noaa
                : tracerArgs(
                      installNoaa(noaa.path).blob.layers as InshoreLayers,
                      boxAround(NOAA_ROUTE.from, NOAA_ROUTE.to, 0.01),
                  ),
    };
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A grid as the main thread gets it: posted with its transfer list (the
 * structured clone a worker's postMessage makes), and which of its fields
 * were transferred rather than copied.
 */
export function receiveGrid(grid: NavGrid, transfer: readonly ArrayBuffer[]): { grid: NavGrid; transferred: string[] } {
    const transferred = Object.keys(grid)
        .filter((key) => {
            const v = (grid as unknown as Record<string, unknown>)[key];
            return ArrayBuffer.isView(v) && transfer.includes(v.buffer as ArrayBuffer);
        })
        .sort();
    return { grid: structuredClone(grid, { transfer: [...transfer] }), transferred };
}

/** The grid field by field (keys sorted): a typed array as `Kind length sha256` of its bytes, anything else as itself. */
export function gridDigest(grid: NavGrid): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(grid).sort()) {
        const v = (grid as unknown as Record<string, unknown>)[key];
        if (ArrayBuffer.isView(v)) {
            const view = v as ArrayBufferView & { length: number };
            fields[key] =
                `${v.constructor.name} ${view.length} ${sha(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))}`;
        } else fields[key] = v;
    }
    return fields;
}

/** A grid's readable summary for its golden. */
export function gridSummary(grid: NavGrid): Record<string, unknown> {
    let blocked = 0;
    for (const c of grid.cells) if (Number.isNaN(c)) blocked++;
    return {
        width: grid.width,
        height: grid.height,
        blocked,
        typedArrays: Object.values(grid).filter((v) => ArrayBuffer.isView(v)).length,
    };
}

const GOLDEN_DIR = resolve(__dirname, '../fixtures/routeJob');

/**
 * Compare a received grid with its golden, or write the golden when
 * ROUTEJOB_GOLDEN_WRITE=1 (only ever on the unchanged code, from today's
 * navGrid worker). The golden holds the sha256 of every field's digest, the
 * fields that came back transferred, and a readable summary. A grid built on
 * the main thread (the fallback) has no transfer list: pass null, and only
 * its fields are compared. Returns what to expect equal: [actual, golden].
 */
export function tracerGridGolden(name: string, grid: NavGrid, transferred: string[] | null): [unknown, unknown] {
    const file = join(GOLDEN_DIR, `${name}.json`);
    const actual = {
        fieldsSha256: createHash('sha256')
            .update(canonicalJson(gridDigest(grid)))
            .digest('hex'),
        ...(transferred ? { transferred } : {}),
        summary: gridSummary(grid),
    };
    if (WRITE_GOLDENS) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
        return [actual, actual];
    }
    const saved = JSON.parse(readFileSync(file, 'utf8')) as typeof actual & { transferred: string[] };
    const expected = {
        fieldsSha256: saved.fieldsSha256,
        ...(transferred ? { transferred: saved.transferred } : {}),
        summary: saved.summary,
    };
    return [actual, expected];
}
