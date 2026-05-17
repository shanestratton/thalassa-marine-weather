#!/usr/bin/env node
/**
 * Stand-alone route driver for end-to-end sanity testing of the senc-extractor →
 * inshoreRouterEngine pipeline.
 *
 * Loads one or more extracted SENC cell JSON files, merges their layers into a
 * single InshoreLayers blob, and asks `routeInshore` to plan a path between two
 * lat/lon points. Emits the result as GPX so it can be dragged into OpenCPN
 * and overlaid on the actual chart for visual sanity.
 *
 * Usage:
 *   route-test --cells <cell.json> [--cells <cell2.json>] \
 *              --from <lat>,<lon> --to <lat>,<lon> \
 *              [--draft <m>] [--out <gpx-path>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { routeInshore, InshoreLayers, RouteRequest } from '../../../services/inshoreRouterEngine.js';

interface Args {
    cells: string[];
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
    draftM: number;
    outGpx: string;
}

function parseLatLon(s: string, label: string): { lat: number; lon: number } {
    const parts = s.split(',').map((x) => Number(x.trim()));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error(`${label} must be "lat,lon" (got "${s}")`);
    }
    return { lat: parts[0], lon: parts[1] };
}

function parseArgs(argv: string[]): Args | null {
    const cells: string[] = [];
    let fromStr = '';
    let toStr = '';
    let draftM = 1.9; // Tayana 55 — sensible default
    let outGpx = './route.gpx';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--cells' && i + 1 < argv.length) cells.push(argv[++i]);
        else if (a === '--from' && i + 1 < argv.length) fromStr = argv[++i];
        else if (a === '--to' && i + 1 < argv.length) toStr = argv[++i];
        else if (a === '--draft' && i + 1 < argv.length) draftM = Number(argv[++i]);
        else if (a === '--out' && i + 1 < argv.length) outGpx = argv[++i];
    }
    if (!cells.length || !fromStr || !toStr) return null;
    return { cells, from: parseLatLon(fromStr, '--from'), to: parseLatLon(toStr, '--to'), draftM, outGpx };
}

/** Concat all FeatureCollections by acronym across multiple cell files. */
function mergeLayers(cellJsons: Array<{ layers: Record<string, { features: unknown[] }> }>): InshoreLayers {
    const out: Record<string, { type: 'FeatureCollection'; features: unknown[] }> = {};
    for (const c of cellJsons) {
        for (const [acronym, fc] of Object.entries(c.layers)) {
            if (!out[acronym]) out[acronym] = { type: 'FeatureCollection', features: [] };
            out[acronym].features.push(...fc.features);
        }
    }
    return out as unknown as InshoreLayers;
}

function toGpx(
    polyline: [number, number][],
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    cautionMask?: boolean[],
): string {
    const trkpts = polyline
        .map(([lon, lat], i) => {
            const caution = cautionMask?.[i - 1] === true;
            const ext = caution ? `<extensions><caution>1</caution></extensions>` : '';
            return `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ext}</trkpt>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="thalassa/senc-extractor"
     xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="${from.lat.toFixed(6)}" lon="${from.lon.toFixed(6)}"><name>From</name></wpt>
  <wpt lat="${to.lat.toFixed(6)}" lon="${to.lon.toFixed(6)}"><name>To</name></wpt>
  <trk>
    <name>Newport → Rivergate (Thalassa inshore router)</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
        console.error(
            'usage: route-test --cells <cell.json>... --from <lat>,<lon> --to <lat>,<lon> [--draft <m>] [--out <gpx>]',
        );
        process.exit(1);
    }

    const cellJsons = await Promise.all(
        args.cells.map(async (path) => {
            const raw = await readFile(path, 'utf8');
            return JSON.parse(raw) as { layers: Record<string, { features: unknown[] }> };
        }),
    );
    const layers = mergeLayers(cellJsons);

    console.log(`Loaded ${args.cells.length} cell(s).`);
    for (const [acronym, fc] of Object.entries(layers as Record<string, { features: unknown[] }>)) {
        console.log(`  ${acronym.padEnd(8)} ${String(fc.features.length).padStart(5)} features`);
    }

    const req: RouteRequest = {
        fromLat: args.from.lat,
        fromLon: args.from.lon,
        toLat: args.to.lat,
        toLon: args.to.lon,
        draftM: args.draftM,
    };
    console.log();
    console.log(
        `Routing from (${req.fromLat}, ${req.fromLon}) → (${req.toLat}, ${req.toLon}) at draft ${req.draftM} m...`,
    );

    const t0 = Date.now();
    const result = routeInshore(layers, req);
    const elapsed = Date.now() - t0;

    if ('error' in (result as object)) {
        const failure = result as { error: string; reason?: string; debug?: unknown };
        console.error(`Route FAILED in ${elapsed}ms: ${failure.error} — ${failure.reason ?? ''}`);
        if (failure.debug) console.error(JSON.stringify(failure.debug, null, 2));
        process.exit(2);
    }

    const route = result as { polyline: [number, number][]; cautionMask?: boolean[]; distanceNM?: number };
    console.log(`Route OK in ${elapsed}ms.`);
    console.log(`  polyline: ${route.polyline.length} points`);
    console.log(`  distance: ${route.distanceNM?.toFixed(2)} NM`);
    if (route.cautionMask) {
        const cautionCount = route.cautionMask.filter(Boolean).length;
        console.log(`  caution segments: ${cautionCount} / ${route.cautionMask.length}`);
    }

    const gpx = toGpx(route.polyline, args.from, args.to, route.cautionMask);
    await writeFile(args.outGpx, gpx);
    console.log(`  wrote GPX: ${args.outGpx}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
