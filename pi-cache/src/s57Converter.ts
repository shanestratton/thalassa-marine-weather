/** Shared S-57 GDAL conversion, used by the boat and the NOAA-only publisher.
 * This module starts no HTTP server, timer or chart vault. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dsidCsvRows, dsidDate, dsidRevision } from './s57Dsid.js';
import {
    conversionLayers,
    ENC_ALWAYS_EMITTED_LAYERS,
    ENC_CONVERSION_SCHEMA,
    dsidDatum,
    dsidCompilationScale,
    ogrinfoLayerFeatureCounts,
    type OgrLayerOutcome,
} from './encLayerContract.js';

/**
 * S-57 layers we extract for routing + rendering. See docs/ENC_INTEGRATION.md.
 *
 * SOURCE OF TRUTH: ROUTING_CLASSES in
 * tools/senc-extractor/src/s57Classes.ts. pi-cache deploys standalone
 * to the Pi, so this list is duplicated here ON PURPOSE — no
 * cross-package import. When ROUTING_CLASSES changes, mirror it here
 * so ogr2ogr-uploaded .000 cells reach rendering parity with
 * SENC-extracted cells.
 *
 * - DEPARE/LNDARE/OBSTRN/WRECKS/UWTROC are hazards (validator drives
 *   the route around them).
 * - COALNE is the coastline — info-only, used by the hazard report
 *   to flag "route passes within X NM of coast" without rerouting.
 * - LIGHTS / BOYLAT / BOYCAR are navigation aids — display only,
 *   render as point symbols on the chart.
 * - M_QUAL ships CATZOC zones for survey-confidence warnings.
 */
const ENC_LAYERS = [
    'DEPARE',
    'LNDARE',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'COALNE',
    'LIGHTS',
    'LITFLT',
    'LITVES',
    'BOYINB',
    'MORFAC',
    'FOGSIG',
    'TOPMAR',
    'DAYMAR',
    'M_VDAT',
    'BOYLAT',
    'BOYCAR',
    'BCNLAT',
    'BCNCAR',
    'M_QUAL',
    // Masterplan Phase 6: NAVLNE/RECTRC = charted leading lines /
    // recommended tracks (offline leads for the routing engine), and
    // FAIRWY/DRGARE were missing from THIS (ogr2ogr upload) path even
    // though the SENC-extractor path emits them — S-57-uploaded cells
    // could never drive corridor preference without them.
    'NAVLNE',
    'RECTRC',
    'FAIRWY',
    'DRGARE',
    // Chartplotter visual pass (2026-06): depth contours + special-purpose
    // buoys/beacons — the RENDERED set, mirroring ROUTING_CLASSES. The wider
    // phase-2 batch (harbour structures, topmarks/daymarks, named areas,
    // anchorages, caution areas) is deferred until its renderers land
    // and is kept OUT here in lock-step — see the ROUTING_CLASSES "Deferred"
    // note for the full list to re-add together.
    'DEPCNT',
    'BOYSPP',
    'BCNSPP',
    // Spot soundings (2026-07-09) — EncVectorLayer draws the numbers now.
    // ogr2ogr emits MultiPoint25D (depth in the Z); the SENC path emits
    // MultiPoint + a `depths` property array — the app's merge handles both.
    'SOUNDG',
    // Safe-water + isolated-danger marks (2026-07-12 audit) — mirrored
    // with ROUTING_CLASSES in lock-step; EncVectorLayer renders them.
    'BOYSAW',
    'BCNSAW',
    'BOYISD',
    'BCNISD',
    // Caution / information AREAS (2026-07-16 ENC-completeness audit) —
    // mirrored with ROUTING_CLASSES; EncVectorLayer draws them as chart
    // furniture. Restricted / cable / pipeline / seabed-nature / TSS.
    'RESARE',
    'CBLARE',
    'PIPARE',
    'SBDARE',
    'TSSLPT',
    // Batch 2 (burn-down): caution note / TSS zone / anchorage / marine farm.
    'CTNARE',
    'TSEZNE',
    'ACHARE',
    'MARCUL',
    'TSELNE',
    'TSSBND',
    'PRCARE',
    'DWRTPT',
    // Man-made allision structures (cycle-5 audit #3) — mirrored with
    // ROUTING_CLASSES. Extracted for the grounding/allision hazard model (not
    // rendered), WATLEV-gated app-side. Existing cells need re-conversion +
    // bucket manifest bump before they take effect.
    'SLCONS',
    'DAMCON',
    'PILPNT',
    // Independent weed/kelp objects (S57 class158, CATWED). Display/advice
    // only; never merged into NATSUR or treated as a crossing caution.
    'WEDKLP',
    // Bridges and overhead clearance (Part B, inshore router, 2026-09-30) —
    // mirrored with ROUTING_CLASSES; for ROUTING, not rendered. BRIDGE /
    // PONTON / CBLOHD / PIPOHD / CONVYR, carrying VERCLR, VERCCL, VERCOP, VERCSA and
    // CATBRG: the router blocks a structure a mast cannot clear, and the
    // lead overlay reviews leads against them. ALWAYS carried, empty when
    // the cell has none (encLayerContract: "extracted, none charted").
    ...ENC_ALWAYS_EMITTED_LAYERS,
] as const;
/** Exported for the layer-contract test (encLayerContract.test.mts). */
export { ENC_LAYERS };

/** Publication cannot turn a failed/partial layer into apparently complete
 * navigation coverage. Boat imports keep the existing unknown-layer policy. */
export function assertCompleteOfficialLayers(
    outcomes: Record<string, OgrLayerOutcome>,
    counts: Record<string, number>,
): void {
    for (const [layer, outcome] of Object.entries(outcomes)) {
        const expected = counts[layer];
        // With -skipfailures GDAL may emit empty/unparseable output for a
        // requested class absent from ogrinfo's independent layer inventory.
        // A class that inventory DOES list must match its complete count.
        if (expected === undefined && (!outcome || outcome === 'absent' || outcome.features.length === 0)) continue;
        if (!outcome || outcome === 'absent' || expected === undefined || outcome.features.length !== expected)
            throw new Error(`Official chart layer ${layer} could not be completely verified`);
    }
}

const OGR2OGR_TIMEOUT_MS = 60 * 1000;

/**
 * Run `ogr2ogr -f GeoJSON output.json input.000 LAYER`.
 * Resolves with the GeoJSON parsed into memory; rejects on
 * non-zero exit code.
 *
 * Note: ogr2ogr writes pretty-printed JSON by default; we parse
 * once here rather than ship the file path back, because the
 * caller will pack everything into the EncConversionResult anyway.
 */
async function runOgr2Ogr(inputPath: string, layer: string, outputDir: string): Promise<OgrLayerOutcome> {
    const outputPath = path.join(outputDir, `${layer}.geojson`);

    const result = await new Promise<number>((resolve, reject) => {
        const proc = spawn(
            'ogr2ogr',
            [
                '-f',
                'GeoJSON',
                '-skipfailures', // don't abort whole layer on one bad feature
                '-t_srs',
                'EPSG:4326', // ensure WGS84 output
                outputPath,
                inputPath,
                layer,
            ],
            { timeout: OGR2OGR_TIMEOUT_MS },
        );
        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ogr2ogr exit ${code} on ${layer}: ${stderr.slice(0, 500)}`));
            } else {
                resolve(code);
            }
        });
    }).catch((err) => {
        // Layer-not-present is a benign error in S-57 — not every
        // cell has every layer. Treat "Cannot find" as a soft miss.
        const msg = err instanceof Error ? err.message : String(err);
        if (/Cannot find|No such layer|cannot open layer/i.test(msg)) return -1;
        throw err;
    });

    // The cell has no such layer: none charted (encLayerContract stamps an
    // empty collection for the always-emitted structure layers).
    if (result === -1) return 'absent';

    try {
        const text = await fs.readFile(outputPath, 'utf8');
        const parsed = JSON.parse(text) as { type: 'FeatureCollection'; features: unknown[] };
        return parsed;
    } catch (err) {
        // Output file missing / unparseable — treat as no data for this layer.
        return null;
    }
}

/**
 * Parse S-57 dataset metadata via ogrinfo. Returns cell ID,
 * edition, issued date, source HO, and the union bbox of the
 * cell's spatial extent.
 */
async function parseS57Metadata(
    inputPath: string,
    strictMetadata = false,
): Promise<{
    cellId: string;
    sourceHO: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    bbox: [number, number, number, number];
    /** Per-layer feature counts from the ogrinfo summary — the structure
     * layers' conversions are held to them (conversionLayers). */
    layerFeatureCounts: Record<string, number>;
    /** Compilation scale denominator (DSID record's DSPM_CSCL), when read. */
    nativeScale?: number;
    soundingDatum?: number;
    verticalDatum?: number;
}> {
    // ogrinfo -al -so produces summary output including DSID (dataset
    // identifier) and per-layer extents. We parse text rather than
    // shelling JSON because GDAL doesn't have a JSON ogrinfo flag
    // until very recent versions.
    const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn('ogrinfo', ['-al', '-so', inputPath], { timeout: OGR2OGR_TIMEOUT_MS });
        let buf = '';
        proc.stdout.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
        });
        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ogrinfo exit ${code}: ${stderr.slice(0, 500)}`));
            } else {
                resolve(buf);
            }
        });
    });

    // ── Cell metadata ──
    // Earlier attempts parsed `ogrinfo -al -so` text output. That
    // turned out to be fragile across GDAL versions — the `-so`
    // flag emits a *schema description* ("DSNM: String (10.0)"),
    // not actual feature values, so the cellId regex was capturing
    // "String" (the GDAL field type). Even after switching to the
    // metadata block format, real-world output varied enough to
    // keep failing.
    //
    // The robust answer: use the filename for the cell ID
    // (NOAA / AHO / UKHO all distribute cells named after their
    // S-57 dataset name — that's the reliable convention) and
    // parse the actual feature values from the DSID layer via
    // `ogr2ogr -f CSV /vsistdout/`. CSV output is structured,
    // version-stable, and trivial to parse.

    // Cell ID — filename basename, validated against the S-57
    // naming convention (2-letter HO code + 4-7 alphanum).
    const cellIdFromFile = path.basename(inputPath, '.000').toUpperCase();
    const cellNameOk = /^[A-Z]{2}[A-Z0-9]{4,7}$/.test(cellIdFromFile);
    const cellId = cellNameOk ? cellIdFromFile : cellIdFromFile.replace(/[^A-Z0-9]/gi, '_');

    // Source HO — first 2 letters of cell ID by S-57 convention
    // (AU = Australia / AHO, US = NOAA, NZ = LINZ, etc.).
    const sourceHO = cellId.slice(0, 2).toUpperCase();

    // ── Edition + issue date via ogr2ogr CSV ──
    // The DSID layer always has exactly one feature carrying the
    // dataset descriptor fields. Convert to CSV → header + one row,
    // parse cleanly. Failure here is non-fatal — we degrade to
    // edition=0 / issued=today, which the UI handles.
    let edition = 0;
    let updateNumber: number | undefined;
    let verifiedMetadata = false;
    let issued = new Date().toISOString().slice(0, 10);
    // Compilation scale (DSPM_CSCL): the phone ranks a cell's survey
    // fineness by it (services/enc/scaleShadow.ts cellFinenessRank) — which
    // chart's land paint a finer survey's water beats (owner decision 1,
    // round 2 2026-09-30). Absent: the phone falls back to the usage band in
    // the cell name (AU5…), then to "unknown" (the land paint stands).
    let nativeScale: number | undefined;
    let soundingDatum: number | undefined;
    let verticalDatum: number | undefined;
    try {
        const csv = await new Promise<string>((resolve, reject) => {
            const proc = spawn('ogr2ogr', ['-f', 'CSV', '/vsistdout/', inputPath, 'DSID'], {
                timeout: OGR2OGR_TIMEOUT_MS,
            });
            let buf = '';
            let stderr = '';
            proc.stdout.on('data', (chunk: Buffer) => {
                buf += chunk.toString('utf8');
            });
            proc.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
            });
            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code !== 0) reject(new Error(`ogr2ogr DSID exit ${code}: ${stderr.slice(0, 200)}`));
                else resolve(buf);
            });
        });
        const [headers, values] = dsidCsvRows(csv);
        const colIdx = Object.fromEntries(headers.map((name, index) => [name, index]));
        const field = (name: string): string | undefined => values[colIdx[name] ?? colIdx[`DSID_${name}`] ?? -1];
        const parsedEdition = dsidRevision(field('EDTN'));
        if (strictMetadata && parsedEdition === 0)
            throw new Error('Official chart is cancelled (effective DSID edition zero)');
        updateNumber = dsidRevision(field('UPDN'));
        const date = dsidDate(field('ISDT')) ?? dsidDate(field('UADT'));
        const dataset = field('DSNM');
        if (
            strictMetadata &&
            (!dataset ||
                dataset.toUpperCase().replace(/\.000$/, '') !== cellId ||
                parsedEdition === undefined ||
                updateNumber === undefined ||
                !date)
        )
            throw new Error('Official chart dataset identity, edition, update or issue date is missing');
        if (parsedEdition !== undefined) edition = parsedEdition;
        if (date) issued = date;
        nativeScale = dsidCompilationScale(colIdx, values) ?? undefined;
        soundingDatum = dsidDatum(colIdx, values, 'SDAT');
        verticalDatum = dsidDatum(colIdx, values, 'VDAT');
        verifiedMetadata = parsedEdition !== undefined && updateNumber !== undefined && !!date;
    } catch (err) {
        if (strictMetadata) throw err;
        // Existing boat imports keep their legacy fallback. NOAA publication
        // always requires strict metadata; it never stamps today as issue age.
        // Non-fatal — keep edition=0 / issued=today. Logged so a
        // sysop can spot the parse failure if they care.

        console.warn(`[enc] DSID parse via ogr2ogr CSV failed for ${cellId}:`, (err as Error).message);
    }

    if (strictMetadata && !verifiedMetadata) throw new Error('Official chart metadata could not be verified');

    // Bbox — Extent: lines have "(minLon, minLat) - (maxLon, maxLat)".
    const extentMatches = [
        ...stdout.matchAll(/Extent:\s*\(([-\d.]+),\s*([-\d.]+)\)\s*-\s*\(([-\d.]+),\s*([-\d.]+)\)/g),
    ];
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const m of extentMatches) {
        const a = parseFloat(m[1]);
        const b = parseFloat(m[2]);
        const c = parseFloat(m[3]);
        const d = parseFloat(m[4]);
        if (a < minLon) minLon = a;
        if (b < minLat) minLat = b;
        if (c > maxLon) maxLon = c;
        if (d > maxLat) maxLat = d;
    }
    if (!Number.isFinite(minLon)) {
        // Shouldn't happen for a valid cell, but fail gracefully.
        throw new Error('Could not extract spatial extent from ENC cell');
    }

    return {
        cellId,
        sourceHO,
        edition,
        ...(updateNumber !== undefined ? { updateNumber } : {}),
        issued,
        bbox: [minLon, minLat, maxLon, maxLat],
        layerFeatureCounts: ogrinfoLayerFeatureCounts(stdout),
        ...(nativeScale !== undefined ? { nativeScale } : {}),
        ...(soundingDatum !== undefined ? { soundingDatum } : {}),
        ...(verticalDatum !== undefined ? { verticalDatum } : {}),
    };
}

/**
 * Convert one S-57 cell file into our EncConversionResult shape.
 * Pulled out of `runConversion` so the multi-cell ZIP loop can
 * call it per cell.
 */
export async function convertOneCell(
    inputPath: string,
    outputDir: string,
    options: { strictMetadata?: boolean } = {},
): Promise<{ result: object; featureCount: number; cellId: string; bbox: [number, number, number, number] }> {
    const meta = await parseS57Metadata(inputPath, options.strictMetadata);

    const outcomes: Record<string, OgrLayerOutcome> = {};
    for (const layer of ENC_LAYERS) outcomes[layer] = await runOgr2Ogr(inputPath, layer, outputDir);
    if (options.strictMetadata) assertCompleteOfficialLayers(outcomes, meta.layerFeatureCounts);
    const { layers, featureCount: totalFeatures } = conversionLayers(outcomes, meta.layerFeatureCounts);

    return {
        result: {
            cellId: meta.cellId,
            sourceHO: meta.sourceHO,
            edition: meta.edition,
            ...(meta.updateNumber !== undefined ? { updateNumber: meta.updateNumber } : {}),
            issued: meta.issued,
            bbox: meta.bbox,
            ...(meta.nativeScale !== undefined ? { nativeScale: meta.nativeScale } : {}),
            ...(meta.soundingDatum !== undefined ? { soundingDatum: meta.soundingDatum } : {}),
            ...(meta.verticalDatum !== undefined ? { verticalDatum: meta.verticalDatum } : {}),
            layers,
            // Which converter schema produced it: a newer one replaces an
            // older conversion of the same revision (encChartStore).
            extractorSchema: ENC_CONVERSION_SCHEMA,
        },
        featureCount: totalFeatures,
        cellId: meta.cellId,
        bbox: meta.bbox,
    };
}
