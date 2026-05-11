/**
 * /api/enc/* — S-57 ENC (Electronic Navigational Chart) conversion.
 *
 * Why this lives on the Pi
 * ────────────────────────
 * S-57 is the IHO standard for electronic navigation charts. Each
 * cell (`.000` file) is a binary container of vector features —
 * depth contours, coastlines, obstructions, wrecks, etc. — issued
 * by hydrographic offices (AHO, NOAA, UKHO).
 *
 * There is no JS S-57 parser. The de-facto tool is GDAL's `ogr2ogr`,
 * a C++ binary. Running GDAL on the boat's Pi (a one-line `apt
 * install gdal-bin`) is dramatically simpler than:
 *   - WASM-GDAL: 50+ MB binary, no S-57 driver in the JS dist
 *   - Cloud edge function: GDAL deploy in serverless is painful
 *   - Native iOS bridge: massive cross-compile job
 *
 * The Pi already does the rest of the heavy work in Bosun's
 * architecture (weather model fetches, GRIB decoding, route
 * pre-compute). ENC conversion fits naturally there.
 *
 * Endpoints
 * ─────────
 *   POST /api/enc/convert
 *     Body: raw `.000` bytes (application/octet-stream)
 *     Header: X-Filename: AU530150.000  ← original filename
 *     → { jobId, status: 'pending' }
 *
 *   GET /api/enc/jobs/:id
 *     → poll for progress / result.
 *       When status='done', body includes a `resultUrl` to fetch
 *       the (potentially large) converted JSON.
 *
 *   GET /api/enc/result/:id
 *     → returns the EncConversionResult JSON. Separate endpoint
 *       so we don't pump a 50 MB blob through every poll.
 *
 *   DELETE /api/enc/jobs/:id
 *     → cleans up temp files for a finished job.
 *
 * License & data residency
 * ────────────────────────
 * The Pi never uploads ENC data anywhere. Cells stay on the user's
 * boat, get converted in-place, and the converted GeoJSON ships
 * straight to the user's phone. We are NOT a redistribution
 * service — the user provides their own legally-licensed cells.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../services/inshoreRouter.js';

// ── Job state ─────────────────────────────────────────────────────

interface EncJob {
    id: string;
    /** Sanitised filename used on disk. */
    filename: string;
    status: 'pending' | 'extracting' | 'converting' | 'done' | 'error';
    /** 0..1 progress estimate. */
    progress: number;
    /** Logged step for the UI ("converting DEPARE", "parsing metadata", ...). */
    step?: string;
    error?: string;
    startedAt: number;
    completedAt?: number;
    /** Path to the converted JSON when done. */
    resultPath?: string;
    /** Path to the temp working directory. */
    workDir?: string;
    /** First cell ID once parsed (for single-file uploads, this is the cell). */
    cellId?: string;
    /** Bbox of the first / single cell. */
    bbox?: [number, number, number, number];
    /** Total feature count across all converted cells. */
    featureCount?: number;
    /** For batch (ZIP) uploads — total cells found in the archive. */
    cellCount?: number;
    /** Cells successfully converted so far (multi-cell jobs). */
    cellsDone?: number;
    /** Cells that errored during batch conversion (filename + reason). */
    skippedCells?: { filename: string; error: string }[];
    /**
     * How the source bytes got onto the Pi. Phone-upload jobs go
     * through POST /convert with a body; URL-install jobs go
     * through POST /install-from-url with the Pi doing the
     * download. Tagged on each persisted cell so the UI can show
     * provenance.
     */
    installSource?: 'phone-upload' | 'url';
    /** When installSource is 'url', the original URL the Pi fetched. */
    installUrl?: string;
    /** Cell IDs that were persisted to the chart store this run. */
    persistedCellIds?: string[];
}

const jobs = new Map<string, EncJob>();

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.completedAt && now - job.completedAt > JOB_TTL_MS) {
            // Best-effort cleanup of temp files.
            if (job.workDir) {
                fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
            }
            jobs.delete(id);
        }
    }
}, JOB_TTL_MS).unref();

// ── Constants ─────────────────────────────────────────────────────

/**
 * S-57 layers we extract for routing. See docs/ENC_INTEGRATION.md.
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
    'BOYLAT',
    'BOYCAR',
    'BCNLAT',
    'BCNCAR',
    'M_QUAL',
] as const;

const TEMP_ROOT = path.join(os.tmpdir(), 'thalassa-enc-conversion');
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300 MB — covers regional AHO/NOAA ZIP packs
const OGR2OGR_TIMEOUT_MS = 60 * 1000; // 1 minute per layer is generous

/**
 * Persistent ENC chart store. The Pi keeps converted ENCs here so
 * they survive restarts and can be served to any device on the
 * boat (Phase 11). One file per cell + a small index for fast
 * listing.
 *
 * Default is install-dir-relative (`./enc-charts`) — same pattern
 * as the existing `./cache` dir. That keeps everything under the
 * `skipper`-owned install dir so the pi-cache process can write
 * without sudo. Override via $ENC_CHART_DIR if a sysop wants the
 * data on a bigger disk.
 */
const CHART_STORE_DIR = process.env.ENC_CHART_DIR || './enc-charts';
const CHART_INDEX_PATH = path.join(CHART_STORE_DIR, 'index.json');
const CHART_CELL_DIR = path.join(CHART_STORE_DIR, 'cells');
const URL_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for big regional ZIPs

// ── Helpers ───────────────────────────────────────────────────────

// ── Persistent chart store ────────────────────────────────────────

/**
 * One entry per converted cell. Kept lean — fields the phone
 * needs to render the chart-locker list without fetching the
 * big GeoJSON blob. The blob lives at `${CHART_CELL_DIR}/<id>.json`.
 */
interface InstalledCellMeta {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    /** Total feature count across hazard layers. */
    featureCount: number;
    /** Size of the on-disk JSON in bytes — UI shows this. */
    sizeBytes: number;
    /** When the Pi finished converting it. */
    installedAt: string;
    /** Where the cell came from — useful for "re-install" flows. */
    source: 'phone-upload' | 'url';
    /** Original source URL when installed via URL. */
    sourceUrl?: string;
}

interface InstalledIndex {
    version: 1;
    cells: InstalledCellMeta[];
}

async function loadInstalledIndex(): Promise<InstalledIndex> {
    try {
        const raw = await fs.readFile(CHART_INDEX_PATH, 'utf8');
        const parsed = JSON.parse(raw) as InstalledIndex;
        if (parsed.version === 1 && Array.isArray(parsed.cells)) return parsed;
    } catch {
        /* fresh install / corrupted — fall through */
    }
    return { version: 1, cells: [] };
}

async function saveInstalledIndex(index: InstalledIndex): Promise<void> {
    await fs.mkdir(CHART_STORE_DIR, { recursive: true });
    await fs.writeFile(CHART_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

function cellStorePath(cellId: string): string {
    // Cell IDs are alphanumeric per S-57 (e.g. AU530150) but sanitise
    // anyway so a malformed metadata can't escape the store dir.
    const safe = cellId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(CHART_CELL_DIR, `${safe}.json`);
}

/**
 * Write one converted cell to the persistent store and update the
 * index. The blob format is `{cells: [single]}` so it matches the
 * EncConversionBatch wire format the phone already understands.
 *
 * Idempotent — re-installing replaces in place.
 */
async function persistCell(
    cell: {
        cellId: string;
        sourceHO: string;
        edition: number;
        issued: string;
        bbox: [number, number, number, number];
        layers: Record<string, unknown>;
    },
    featureCount: number,
    source: 'phone-upload' | 'url',
    sourceUrl?: string,
): Promise<InstalledCellMeta> {
    await fs.mkdir(CHART_CELL_DIR, { recursive: true });
    const blob = { cells: [cell] };
    const data = JSON.stringify(blob);
    const filePath = cellStorePath(cell.cellId);
    await fs.writeFile(filePath, data, 'utf8');

    const meta: InstalledCellMeta = {
        cellId: cell.cellId,
        sourceHO: cell.sourceHO,
        edition: cell.edition,
        issued: cell.issued,
        bbox: cell.bbox,
        featureCount,
        sizeBytes: Buffer.byteLength(data, 'utf8'),
        installedAt: new Date().toISOString(),
        source,
        sourceUrl,
    };

    const index = await loadInstalledIndex();
    const existingIdx = index.cells.findIndex((c) => c.cellId === cell.cellId);
    if (existingIdx >= 0) index.cells[existingIdx] = meta;
    else index.cells.push(meta);
    await saveInstalledIndex(index);
    return meta;
}

async function removeInstalledCell(cellId: string): Promise<boolean> {
    const index = await loadInstalledIndex();
    const before = index.cells.length;
    index.cells = index.cells.filter((c) => c.cellId !== cellId);
    if (index.cells.length === before) return false;
    await saveInstalledIndex(index);
    try {
        await fs.unlink(cellStorePath(cellId));
    } catch {
        /* file may already be gone */
    }
    return true;
}

// ── Helpers ───────────────────────────────────────────────────────

function sanitiseFilename(name: string): string {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
    if (!safe || safe === '.' || safe === '..') return 'cell.000';
    return safe;
}

/**
 * Run `ogr2ogr -f GeoJSON output.json input.000 LAYER`.
 * Resolves with the GeoJSON parsed into memory; rejects on
 * non-zero exit code.
 *
 * Note: ogr2ogr writes pretty-printed JSON by default; we parse
 * once here rather than ship the file path back, because the
 * caller will pack everything into the EncConversionResult anyway.
 */
async function runOgr2Ogr(
    inputPath: string,
    layer: string,
    outputDir: string,
): Promise<{ type: 'FeatureCollection'; features: unknown[] } | null> {
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

    if (result === -1) return null;

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
async function parseS57Metadata(inputPath: string): Promise<{
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
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
    let issued = new Date().toISOString().slice(0, 10);
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
        const lines = csv.trim().split(/\r?\n/);
        if (lines.length >= 2) {
            const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, ''));
            const values = lines[1].split(',').map((v) => v.replace(/^"|"$/g, ''));
            const colIdx: Record<string, number> = {};
            headers.forEach((h, i) => {
                colIdx[h.toUpperCase()] = i;
            });

            const edtnIdx = colIdx['EDTN'] ?? colIdx['DSID_EDTN'] ?? -1;
            if (edtnIdx >= 0) {
                const v = parseInt(values[edtnIdx] ?? '', 10);
                if (Number.isFinite(v)) edition = v;
            }
            const uadtIdx = colIdx['UADT'] ?? colIdx['DSID_UADT'] ?? -1;
            if (uadtIdx >= 0 && /^\d{8}$/.test(values[uadtIdx] ?? '')) {
                const u = values[uadtIdx];
                issued = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
            }
            // TODO(phase-12-polish): two small UX upgrades worth doing
            // when we revisit the chart-locker UI:
            //   1. Capture DSID_UPDN and surface it as "ed.0u2" (or
            //      "edition 0, update 2") in the cell row label. NOAA
            //      ships many cells at edition 0 with N updates
            //      applied — currently the user sees "ed.0" and has
            //      no signal that the chart has been updated since.
            //   2. Prefer DSID_ISDT (chart issue date) over DSID_UADT
            //      (date this update was applied) when both are
            //      present. ISDT is what cruisers usually mean when
            //      they ask "how old is this chart?" UADT only tells
            //      you when the latest patch landed.
            // Both require: extending the wire format (EncCell.update
            // / EncCell.isdt) + UI tweak in EncCellManager.
        }
    } catch (err) {
        // Non-fatal — keep edition=0 / issued=today. Logged so a
        // sysop can spot the parse failure if they care.
        // eslint-disable-next-line no-console
        console.warn(`[enc] DSID parse via ogr2ogr CSV failed for ${cellId}:`, (err as Error).message);
    }

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
        issued,
        bbox: [minLon, minLat, maxLon, maxLat],
    };
}

/**
 * Read the first 4 bytes of a file. Used to sniff ZIP magic bytes
 * (PK\x03\x04) before we trust an extension.
 */
async function readMagicBytes(filePath: string, n = 4): Promise<Buffer> {
    const fh = await fs.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        await fh.read(buf, 0, n, 0);
        return buf;
    } finally {
        await fh.close();
    }
}

function isZipFile(magic: Buffer): boolean {
    // PK\x03\x04 (regular zip) or PK\x05\x06 (empty zip) or PK\x07\x08 (spanned)
    if (magic.length < 4) return false;
    return magic[0] === 0x50 && magic[1] === 0x4b;
}

/**
 * Walk the extracted ENC_ROOT tree finding every `.000` cell file.
 * Returns absolute paths. Update files (.001..009) are NOT
 * returned — they live alongside the .000 in the same directory
 * and GDAL's S-57 driver applies them automatically.
 */
async function findEncCells(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (e.isFile() && /\.000$/i.test(e.name)) out.push(full);
        }
    }
    await walk(root);
    return out;
}

/**
 * Convert one S-57 cell file into our EncConversionResult shape.
 * Pulled out of `runConversion` so the multi-cell ZIP loop can
 * call it per cell.
 */
async function convertOneCell(
    inputPath: string,
    outputDir: string,
): Promise<{ result: object; featureCount: number; cellId: string; bbox: [number, number, number, number] }> {
    const meta = await parseS57Metadata(inputPath);

    const layers: Record<string, unknown> = {};
    let totalFeatures = 0;
    for (const layer of ENC_LAYERS) {
        const fc = await runOgr2Ogr(inputPath, layer, outputDir);
        if (fc && Array.isArray(fc.features)) {
            layers[layer] = fc;
            totalFeatures += fc.features.length;
        }
    }

    return {
        result: {
            cellId: meta.cellId,
            sourceHO: meta.sourceHO,
            edition: meta.edition,
            issued: meta.issued,
            bbox: meta.bbox,
            layers,
        },
        featureCount: totalFeatures,
        cellId: meta.cellId,
        bbox: meta.bbox,
    };
}

/**
 * Background job runner. Detects whether the upload is a single
 * `.000` or a ZIP archive of cells, processes accordingly, and
 * writes a single EncConversionBatch JSON file to disk.
 *
 * Always returns a batch envelope ({cells: [...], skipped?: [...]}),
 * even for single-cell uploads — keeps the device-side import flow
 * uniform.
 */
async function runConversion(job: EncJob): Promise<void> {
    if (!job.workDir) throw new Error('workDir not set');
    const inputPath = path.join(job.workDir, job.filename);

    job.status = 'extracting';
    job.step = 'inspecting upload';
    const magic = await readMagicBytes(inputPath);

    const outputBaseDir = path.join(job.workDir, 'out');
    await fs.mkdir(outputBaseDir, { recursive: true });

    const cells: object[] = [];
    const skipped: { filename: string; error: string }[] = [];

    if (isZipFile(magic)) {
        // ── ZIP MODE ─────────────────────────────────────────────
        job.step = 'unzipping archive';
        const unzipDir = path.join(job.workDir, 'unzipped');
        await fs.mkdir(unzipDir, { recursive: true });

        try {
            const zip = new AdmZip(inputPath);
            zip.extractAllTo(unzipDir, /* overwrite */ true);
        } catch (err) {
            throw new Error(`Failed to unzip: ${(err as Error).message}`);
        }

        const cellPaths = await findEncCells(unzipDir);
        if (cellPaths.length === 0) {
            throw new Error('No .000 cell files found in ZIP');
        }
        job.cellCount = cellPaths.length;
        job.cellsDone = 0;

        for (let i = 0; i < cellPaths.length; i++) {
            const cellPath = cellPaths[i];
            const cellName = path.basename(cellPath);
            job.step = `converting ${cellName} (${i + 1}/${cellPaths.length})`;
            job.progress = 0.05 + (i / cellPaths.length) * 0.9;
            try {
                const cellOutDir = path.join(outputBaseDir, path.basename(cellPath, '.000'));
                await fs.mkdir(cellOutDir, { recursive: true });
                const conv = await convertOneCell(cellPath, cellOutDir);
                cells.push(conv.result);
                // Persist to the Pi-side chart store immediately
                // so subsequent boats / devices can pull it from
                // `/api/enc/installed/:cellId/data` without re-
                // running the conversion.
                await persistCell(
                    conv.result as Parameters<typeof persistCell>[0],
                    conv.featureCount,
                    job.installSource ?? 'phone-upload',
                    job.installUrl,
                );
                job.persistedCellIds = [...(job.persistedCellIds ?? []), conv.cellId];
                if (job.cellId == null) {
                    job.cellId = conv.cellId;
                    job.bbox = conv.bbox;
                }
                job.featureCount = (job.featureCount ?? 0) + conv.featureCount;
                job.cellsDone = (job.cellsDone ?? 0) + 1;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                skipped.push({ filename: cellName, error: msg });
            }
        }
        if (cells.length === 0) {
            throw new Error(`All ${cellPaths.length} cells in archive failed to convert`);
        }
    } else {
        // ── SINGLE-CELL MODE ─────────────────────────────────────
        job.cellCount = 1;
        job.cellsDone = 0;
        job.step = 'parsing metadata';
        job.progress = 0.1;
        const conv = await convertOneCell(inputPath, outputBaseDir);
        cells.push(conv.result);
        await persistCell(
            conv.result as Parameters<typeof persistCell>[0],
            conv.featureCount,
            job.installSource ?? 'phone-upload',
            job.installUrl,
        );
        job.persistedCellIds = [conv.cellId];
        job.cellId = conv.cellId;
        job.bbox = conv.bbox;
        job.featureCount = conv.featureCount;
        job.cellsDone = 1;
    }

    if (skipped.length > 0) job.skippedCells = skipped;

    const batch = {
        cells,
        ...(skipped.length > 0 ? { skipped } : {}),
    };
    const resultPath = path.join(job.workDir, 'result.json');
    await fs.writeFile(resultPath, JSON.stringify(batch), 'utf8');
    job.resultPath = resultPath;
    job.progress = 1;
    job.step = 'done';
    job.status = 'done';
    job.completedAt = Date.now();
}

// ── Routes ────────────────────────────────────────────────────────

export function createEncRoutes(): Router {
    const router = Router();

    // Capture raw body up to MAX_UPLOAD_BYTES for the convert endpoint.
    // We mount this only on /convert so we don't load big buffers
    // for every request to the router.
    const rawBodyParser = (req: Request, res: Response, next: () => void): void => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_UPLOAD_BYTES) {
                res.status(413).json({ error: 'Upload too large (max 300 MB)' });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
            next();
        });
        req.on('error', (err) => {
            res.status(400).json({ error: `Upload read failed: ${err.message}` });
        });
    };

    /**
     * POST /api/enc/convert
     * Body: raw S-57 cell bytes (.000 file), OR a base64 string
     *       when X-Body-Encoding: base64 is set (the path the
     *       Thalassa iOS app uses, since CapacitorHttp's binary-
     *       body support is unreliable cross-platform).
     * Headers: X-Filename: AU530150.000
     *          X-Body-Encoding: base64  (optional)
     */
    router.post('/convert', rawBodyParser, async (req: Request, res: Response) => {
        let rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
        if (!rawBody || rawBody.length === 0) {
            return res.status(400).json({ error: 'Empty body' });
        }

        // Optional base64 decode for clients that can't send raw
        // binary reliably. We trust the header — this endpoint isn't
        // public-facing (Pi is on the boat LAN) so payload-validation
        // attacks aren't a real risk here.
        const encoding = req.header('x-body-encoding') || req.header('X-Body-Encoding');
        if (encoding && encoding.toLowerCase() === 'base64') {
            try {
                const ascii = rawBody.toString('utf8');
                rawBody = Buffer.from(ascii, 'base64');
                if (rawBody.length === 0) {
                    return res.status(400).json({ error: 'Body decoded to zero bytes — bad base64?' });
                }
            } catch (err) {
                return res.status(400).json({ error: `Failed to base64-decode body: ${(err as Error).message}` });
            }
        }

        const filenameHeader = req.header('x-filename') || req.header('X-Filename') || 'cell.000';
        const filename = sanitiseFilename(filenameHeader);

        const jobId = randomUUID();
        const workDir = path.join(TEMP_ROOT, jobId);
        try {
            await fs.mkdir(workDir, { recursive: true });
            await fs.writeFile(path.join(workDir, filename), rawBody);
        } catch (err) {
            return res.status(500).json({ error: `Failed to stage upload: ${(err as Error).message}` });
        }

        const job: EncJob = {
            id: jobId,
            filename,
            status: 'pending',
            progress: 0,
            startedAt: Date.now(),
            workDir,
        };
        jobs.set(jobId, job);

        // Run conversion in the background so the client can poll.
        void runConversion(job).catch((err) => {
            job.status = 'error';
            job.error = err instanceof Error ? err.message : String(err);
            job.completedAt = Date.now();
            job.progress = 0;
        });

        return res.json({ jobId, status: 'pending' });
    });

    /** GET /api/enc/jobs/:id — poll for progress. */
    router.get('/jobs/:id', (req: Request, res: Response) => {
        const id = req.params.id;
        if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' });
        const job = jobs.get(id);
        if (!job) return res.status(404).json({ error: 'Job not found' });

        // Public job summary — exclude server-only fields like workDir.
        return res.json({
            id: job.id,
            filename: job.filename,
            status: job.status,
            progress: job.progress,
            step: job.step,
            error: job.error,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            cellId: job.cellId,
            bbox: job.bbox,
            featureCount: job.featureCount,
            cellCount: job.cellCount,
            cellsDone: job.cellsDone,
            skippedCells: job.skippedCells,
            resultUrl: job.status === 'done' ? `/api/enc/result/${job.id}` : undefined,
        });
    });

    /** GET /api/enc/result/:id — fetch the converted JSON. */
    router.get('/result/:id', async (req: Request, res: Response) => {
        const id = req.params.id;
        if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' });
        const job = jobs.get(id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.status !== 'done' || !job.resultPath) {
            return res.status(409).json({ error: `Job not ready: ${job.status}` });
        }
        try {
            const text = await fs.readFile(job.resultPath, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            return res.send(text);
        } catch (err) {
            return res.status(500).json({ error: `Failed to read result: ${(err as Error).message}` });
        }
    });

    /** DELETE /api/enc/jobs/:id — cleans up temp files for a finished job. */
    router.delete('/jobs/:id', async (req: Request, res: Response) => {
        const id = req.params.id;
        if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' });
        const job = jobs.get(id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.workDir) {
            await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
        }
        jobs.delete(id);
        return res.json({ ok: true });
    });

    /**
     * POST /api/enc/install-from-url
     * Body: { url: string, filename?: string }
     *
     * Pi downloads the file from the supplied URL (typically a free
     * NOAA ENC ZIP), runs the same conversion pipeline as a phone
     * upload, and persists every successfully-converted cell to the
     * chart store. The Pi has stable internet, no iOS file-picker
     * friction, and only needs to do the heavy work once per chart
     * — every device on the boat then pulls from the persistent
     * store via /api/enc/installed.
     *
     * Returns the same {jobId, status} envelope as /convert so the
     * client can poll progress with the existing /jobs/:id flow.
     */
    router.post('/install-from-url', async (req: Request, res: Response) => {
        const { url, filename } = (req.body ?? {}) as { url?: string; filename?: string };
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'Body must include {url}' });
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return res.status(400).json({ error: 'Only http/https URLs are allowed' });
        }

        const safeName = sanitiseFilename(filename ?? path.basename(parsed.pathname) ?? 'cell.zip');

        const jobId = randomUUID();
        const workDir = path.join(TEMP_ROOT, jobId);
        try {
            await fs.mkdir(workDir, { recursive: true });
        } catch (err) {
            return res.status(500).json({ error: `Failed to stage workdir: ${(err as Error).message}` });
        }

        const job: EncJob = {
            id: jobId,
            filename: safeName,
            status: 'pending',
            progress: 0,
            startedAt: Date.now(),
            workDir,
            installSource: 'url',
            installUrl: url,
        };
        jobs.set(jobId, job);

        // Background task: download + convert + persist.
        void (async () => {
            try {
                job.status = 'extracting';
                job.step = 'downloading from upstream';
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), URL_DOWNLOAD_TIMEOUT_MS);
                let response;
                try {
                    response = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
                } finally {
                    clearTimeout(timer);
                }
                if (!response.ok) {
                    throw new Error(`Upstream HTTP ${response.status}`);
                }
                const total = Number(response.headers.get('content-length') ?? 0);
                if (total > MAX_UPLOAD_BYTES) {
                    throw new Error(`Upstream file is ${(total / 1024 / 1024).toFixed(0)} MB — exceeds 300 MB cap`);
                }
                if (!response.body) throw new Error('Upstream returned no body');

                const downloadPath = path.join(workDir, safeName);
                const out = createWriteStream(downloadPath);
                let downloaded = 0;
                const reader = response.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        downloaded += value.byteLength;
                        if (downloaded > MAX_UPLOAD_BYTES) {
                            throw new Error('Upstream exceeded 300 MB during stream');
                        }
                        out.write(Buffer.from(value));
                        if (total > 0) {
                            // Reserve 0..0.05 of the progress bar
                            // for the download portion; conversion
                            // moves the rest.
                            job.progress = Math.min(0.05, (downloaded / total) * 0.05);
                        }
                    }
                }
                out.end();
                await new Promise<void>((resolve, reject) => {
                    out.on('finish', () => resolve());
                    out.on('error', reject);
                });

                // Hand off to the existing pipeline. runConversion
                // checks magic bytes, unzips if needed, persists each
                // cell to the chart store via persistCell.
                await runConversion(job);
            } catch (err) {
                job.status = 'error';
                job.error = err instanceof Error ? err.message : String(err);
                job.completedAt = Date.now();
                job.progress = 0;
            }
        })();

        return res.json({ jobId, status: 'pending' });
    });

    /**
     * GET /api/enc/installed
     * Returns the metadata index of every cell the Pi has ever
     * converted and stored. Phones use this to show the chart
     * locker without having to know which boat has which charts.
     */
    router.get('/installed', async (_req: Request, res: Response) => {
        try {
            const index = await loadInstalledIndex();
            return res.json({ cells: index.cells, totalSizeBytes: index.cells.reduce((s, c) => s + c.sizeBytes, 0) });
        } catch (err) {
            return res.status(500).json({ error: `Failed to read chart store: ${(err as Error).message}` });
        }
    });

    /**
     * GET /api/enc/installed/:cellId/data
     * Returns the converted GeoJSON blob for a specific cell.
     * Same wire format the device-side import flow already
     * understands ({cells: [...], skipped?: [...]}).
     */
    router.get('/installed/:cellId/data', async (req: Request, res: Response) => {
        const cellId = req.params.cellId;
        if (typeof cellId !== 'string' || !cellId) {
            return res.status(400).json({ error: 'Invalid cellId' });
        }
        const filePath = cellStorePath(cellId);
        try {
            const text = await fs.readFile(filePath, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            return res.send(text);
        } catch (err) {
            const msg =
                (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Cell not installed' : (err as Error).message;
            return res.status(404).json({ error: msg });
        }
    });

    /**
     * DELETE /api/enc/installed/:cellId
     * Removes a cell from the chart store. Idempotent; returns
     * 404 only if the cell was never installed.
     */
    router.delete('/installed/:cellId', async (req: Request, res: Response) => {
        const cellId = req.params.cellId;
        if (typeof cellId !== 'string' || !cellId) {
            return res.status(400).json({ error: 'Invalid cellId' });
        }
        const removed = await removeInstalledCell(cellId);
        if (!removed) return res.status(404).json({ error: 'Cell not installed' });
        return res.json({ ok: true, cellId });
    });

    /**
     * POST /api/enc/route
     *
     * Inshore A* routing through the installed ENC cells. Accepts
     * origin/destination + draft, returns a polyline that follows
     * channels and dodges land/shallow water/obstructions. See
     * services/inshoreRouter.ts for the algorithm.
     *
     * Body: {
     *   fromLat, fromLon, toLat, toLon: number,
     *   draftM: number,
     *   cellIds?: string[],         // explicit; default = all cells whose bbox intersects the route
     *   resolutionM?: number,       // default 50 m
     *   safetyM?: number,           // additional draft margin, default 1 m
     *   obstructionBufferM?: number // default 30 m
     * }
     *
     * 200 → { polyline: [[lon,lat],...], distanceNM, cellsUsed: string[], gridSize, ... }
     * 422 → { error, code? } when grid build succeeded but no path exists
     * 4xx → input validation
     * 5xx → unexpected
     */
    router.post('/route', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Partial<{
            fromLat: number;
            fromLon: number;
            toLat: number;
            toLon: number;
            draftM: number;
            cellIds: string[];
            resolutionM: number;
            safetyM: number;
            obstructionBufferM: number;
            minComponentCells: number;
        }>;

        // ── Input validation ──
        const numericFields: (keyof typeof body)[] = ['fromLat', 'fromLon', 'toLat', 'toLon', 'draftM'];
        for (const k of numericFields) {
            if (typeof body[k] !== 'number' || !Number.isFinite(body[k])) {
                return res.status(400).json({ error: `Missing or invalid number: ${k}` });
            }
        }
        const fromLat = body.fromLat as number;
        const fromLon = body.fromLon as number;
        const toLat = body.toLat as number;
        const toLon = body.toLon as number;
        const draftM = body.draftM as number;

        if (Math.abs(fromLat) > 90 || Math.abs(toLat) > 90 || Math.abs(fromLon) > 180 || Math.abs(toLon) > 180) {
            return res.status(400).json({ error: 'Coordinates out of WGS84 range' });
        }
        if (draftM < 0 || draftM > 30) {
            return res.status(400).json({ error: 'draftM out of plausible range (0–30 m)' });
        }

        // ── Cell selection ──
        // Either explicit cellIds, or auto-pick cells whose bbox
        // intersects the route's lat/lon envelope.
        let candidates: string[] | undefined = body.cellIds;
        const index = await loadInstalledIndex();
        if (!candidates || candidates.length === 0) {
            const minLat = Math.min(fromLat, toLat);
            const maxLat = Math.max(fromLat, toLat);
            const minLon = Math.min(fromLon, toLon);
            const maxLon = Math.max(fromLon, toLon);
            candidates = index.cells
                .filter((c) => {
                    const [bMinLon, bMinLat, bMaxLon, bMaxLat] = c.bbox;
                    return !(bMaxLon < minLon || bMinLon > maxLon || bMaxLat < minLat || bMinLat > maxLat);
                })
                .map((c) => c.cellId);
        }

        if (candidates.length === 0) {
            return res.status(404).json({
                error: 'No installed ENC cells cover this route. Import a chart for this area first.',
                code: 'no-coverage',
            });
        }

        // ── Layer loading ──
        // Load each cell's persisted blob; concat features per layer
        // into one merged InshoreLayers struct. The router doesn't
        // care which cell a feature came from.
        const merged: InshoreLayers = {
            LNDARE: { type: 'FeatureCollection', features: [] },
            DEPARE: { type: 'FeatureCollection', features: [] },
            OBSTRN: { type: 'FeatureCollection', features: [] },
            WRECKS: { type: 'FeatureCollection', features: [] },
            UWTROC: { type: 'FeatureCollection', features: [] },
            FAIRWY: { type: 'FeatureCollection', features: [] },
            DRGARE: { type: 'FeatureCollection', features: [] },
            BOYLAT: { type: 'FeatureCollection', features: [] },
            BCNLAT: { type: 'FeatureCollection', features: [] },
        };
        const cellsUsed: string[] = [];
        for (const cellId of candidates) {
            try {
                const text = await fs.readFile(cellStorePath(cellId), 'utf8');
                const blob = JSON.parse(text) as {
                    cells: { layers: Record<string, { features?: unknown[] }> }[];
                };
                const cell = blob.cells?.[0];
                if (!cell) continue;
                for (const layer of [
                    'LNDARE',
                    'DEPARE',
                    'OBSTRN',
                    'WRECKS',
                    'UWTROC',
                    'FAIRWY',
                    'DRGARE',
                    'BOYLAT',
                    'BCNLAT',
                ] as const) {
                    const fc = cell.layers?.[layer];
                    if (fc?.features && Array.isArray(fc.features)) {
                        // Features came from GDAL→GeoJSON so they conform to the
                        // GeoJSON Feature shape; the persistence layer is just
                        // typed `unknown[]` to avoid forcing a deep import.
                        const target = merged[layer];
                        if (target) {
                            (target.features as unknown[]).push(...fc.features);
                        }
                    }
                }
                cellsUsed.push(cellId);
            } catch {
                // Cell file missing/corrupt — skip and continue with the others.
            }
        }

        if (cellsUsed.length === 0) {
            return res.status(500).json({ error: 'Failed to load any cell GeoJSON' });
        }

        // ── Route ──
        try {
            const t0 = Date.now();
            const reqRoute: RouteRequest = {
                fromLat,
                fromLon,
                toLat,
                toLon,
                draftM,
                resolutionM: body.resolutionM,
                safetyM: body.safetyM,
                obstructionBufferM: body.obstructionBufferM,
                minComponentCells: body.minComponentCells,
            };
            const result = routeInshore(merged, reqRoute);
            const elapsedMs = Date.now() - t0;

            if ('error' in result) {
                return res.status(422).json({ ...result, cellsUsed, elapsedMs });
            }
            return res.json({ ...result, cellsUsed, elapsedMs });
        } catch (err) {
            return res
                .status(500)
                .json({ error: `Routing failed: ${err instanceof Error ? err.message : String(err)}` });
        }
    });

    /**
     * POST /api/enc/install-public
     *
     * Ingests a Phase 14 PIVOT public-data GeoJSON pack as a chart
     * cell in the same store the NOAA-imported cells live in. Phase 13's
     * inshore router consumes the result unchanged — same DEPARE/
     * LNDARE/etc. shape going in, same A* coming out.
     *
     * Input GeoJSON should be a FeatureCollection where each Feature
     * has a `_layer` property identifying its S-57 class:
     *
     *   {
     *     "type": "FeatureCollection",
     *     "features": [
     *       { "properties": { "_layer": "DEPARE", "DRVAL1": 0, "DRVAL2": 2 },
     *         "geometry": ... },
     *       { "properties": { "_layer": "LNDARE" }, "geometry": ... },
     *       ...
     *     ]
     *   }
     *
     * pack-generator's gdal_contour spike emits exactly this shape
     * for DEPARE; the full pack generator will mix DEPARE + LNDARE +
     * WRECKS + OBSTRN + others.
     *
     * Body: {
     *   region: string,        // e.g. "au-brisbane-test" — becomes cellId
     *   sourceHO?: string,     // e.g. "PUB-GMRT" — attribution
     *   geojson: FeatureCollection
     * }
     *
     * The server:
     *   1. Validates shape
     *   2. Groups features by _layer
     *   3. Computes union bbox
     *   4. Persists to enc-charts/cells/<region>.json (same flat
     *      namespace as NOAA imports)
     *   5. Updates the chart-store index so /installed lists it
     */
    router.post('/install-public', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Partial<{
            region: string;
            sourceHO: string;
            geojson: {
                type?: string;
                features?: Array<{
                    type?: string;
                    properties?: Record<string, unknown> & { _layer?: string };
                    geometry?: { type: string; coordinates: unknown };
                }>;
            };
        }>;

        // ── Validation ──
        if (!body.region || typeof body.region !== 'string') {
            return res.status(400).json({ error: 'Body must include {region: string}' });
        }
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(body.region)) {
            return res.status(400).json({
                error: 'region must be alphanumeric + dash/underscore, ≤64 chars',
            });
        }
        if (!body.geojson || body.geojson.type !== 'FeatureCollection' || !Array.isArray(body.geojson.features)) {
            return res.status(400).json({
                error: 'geojson must be a GeoJSON FeatureCollection',
            });
        }
        const features = body.geojson.features;
        if (features.length === 0) {
            return res.status(400).json({ error: 'FeatureCollection must contain at least one Feature' });
        }

        // ── Group features by _layer ──
        // Each Feature is required to have properties._layer naming
        // its S-57 class. The inshore router iterates layers by
        // their canonical name (DEPARE, LNDARE, etc.) so we must
        // bucket them server-side.
        const layerBuckets: Record<string, typeof features> = {};
        let untaggedCount = 0;
        for (const f of features) {
            const layer = f.properties?._layer;
            if (typeof layer !== 'string' || !/^[A-Z]{3,6}$/.test(layer)) {
                untaggedCount++;
                continue;
            }
            if (!layerBuckets[layer]) layerBuckets[layer] = [];
            layerBuckets[layer].push(f);
        }
        if (untaggedCount > 0 && Object.keys(layerBuckets).length === 0) {
            return res.status(400).json({
                error: 'No features had a valid _layer property (expected uppercase S-57 code like DEPARE)',
                untaggedCount,
            });
        }

        // ── Compute union bbox ──
        let minLon = Infinity,
            minLat = Infinity,
            maxLon = -Infinity,
            maxLat = -Infinity;
        const walk = (coords: unknown): void => {
            if (!Array.isArray(coords)) return;
            if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                const lon = coords[0] as number;
                const lat = coords[1] as number;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                return;
            }
            for (const inner of coords) walk(inner);
        };
        for (const f of features) walk(f.geometry?.coordinates);
        if (!Number.isFinite(minLon)) {
            return res.status(400).json({ error: 'Could not compute bbox — no numeric coordinates found' });
        }

        // ── Build the cell record in the same shape as NOAA imports ──
        // Auto-bump the edition number on every re-install of the same
        // region. Phone-side sync diffs on `cellId@edition` (see
        // services/EncImportService.ts:415) — without a bump the device
        // never re-pulls when we regenerate the public-data pack with
        // new layers / finer contours / better simplification.
        const existingIndex = await loadInstalledIndex();
        const existing = existingIndex.cells.find((c) => c.cellId === body.region);
        const nextEdition = existing ? existing.edition + 1 : 1;
        const cell = {
            cellId: body.region,
            sourceHO: body.sourceHO || 'PUB',
            edition: nextEdition,
            issued: new Date().toISOString().slice(0, 10),
            bbox: [minLon, minLat, maxLon, maxLat] as [number, number, number, number],
            layers: Object.fromEntries(
                Object.entries(layerBuckets).map(([layer, feats]) => [
                    layer,
                    { type: 'FeatureCollection' as const, features: feats },
                ]),
            ),
        };

        try {
            const meta = await persistCell(
                cell as unknown as Parameters<typeof persistCell>[0],
                features.length - untaggedCount,
                'url', // closest existing source-type label; future: 'public-data'
                undefined,
            );
            return res.json({
                ok: true,
                cellId: meta.cellId,
                bbox: meta.bbox,
                featureCount: meta.featureCount,
                sizeBytes: meta.sizeBytes,
                layers: Object.keys(layerBuckets).map((k) => ({
                    layer: k,
                    count: layerBuckets[k].length,
                })),
                untaggedFeatures: untaggedCount,
            });
        } catch (err) {
            return res
                .status(500)
                .json({ error: `Failed to persist public pack: ${err instanceof Error ? err.message : String(err)}` });
        }
    });

    /** GET /api/enc/health — quick sanity check for whether GDAL is installed. */
    router.get('/health', async (_req: Request, res: Response) => {
        try {
            const version = await new Promise<string>((resolve, reject) => {
                const proc = spawn('ogr2ogr', ['--version'], { timeout: 5000 });
                let buf = '';
                proc.stdout.on('data', (chunk: Buffer) => {
                    buf += chunk.toString('utf8');
                });
                proc.on('error', reject);
                proc.on('close', (code) => (code === 0 ? resolve(buf.trim()) : reject(new Error(`exit ${code}`))));
            });
            return res.json({ ok: true, gdal: version });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'GDAL/ogr2ogr not installed. Run: sudo apt install gdal-bin',
                detail: err instanceof Error ? err.message : String(err),
            });
        }
    });

    return router;
}
