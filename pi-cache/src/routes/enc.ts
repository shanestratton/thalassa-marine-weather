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

    // Cell ID — DSID:DSNM line in S-57 driver output.
    const dsnmMatch = stdout.match(/DSNM:\s*(\S+)/) || stdout.match(/DSID_DSNM:\s*(\S+)/);
    const cellId = dsnmMatch ? dsnmMatch[1].replace(/\.000$/i, '') : path.basename(inputPath, '.000');

    // Edition number — DSID:EDTN.
    const edtnMatch = stdout.match(/EDTN:\s*(\d+)/) || stdout.match(/DSID_EDTN:\s*(\d+)/);
    const edition = edtnMatch ? parseInt(edtnMatch[1], 10) : 0;

    // Issue date — DSID:UADT (YYYYMMDD).
    const uadtMatch = stdout.match(/UADT:\s*(\d{8})/) || stdout.match(/DSID_UADT:\s*(\d{8})/);
    const issued = uadtMatch
        ? `${uadtMatch[1].slice(0, 4)}-${uadtMatch[1].slice(4, 6)}-${uadtMatch[1].slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

    // Source HO — first 2 letters of cell ID by S-57 convention
    // (AU = Australia / AHO, US = NOAA, NZ = LINZ, etc.).
    const sourceHO = cellId.slice(0, 2).toUpperCase();

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
