/**
 * /api/charts/* — Chart download endpoints for pi-direct chart installs.
 *
 * Why this exists
 * ───────────────
 * The Thalassa app's "Chart Locker" lets users install free charts (NOAA
 * MBTiles, LINZ, community packages) into AvNav. Two historical modes:
 *
 *   - phone-proxy: phone downloads chart → uploads to Pi → deletes from phone
 *   - pi-direct:   tells Pi to download from URL directly
 *
 * Phone-proxy was unreliable on iOS Capacitor (XHR streaming + Filesystem
 * progress events have known quirks; users saw "stuck at 1%" hangs even
 * when downloads succeeded silently in the background).
 *
 * Pi-direct previously called a fake AvNav endpoint (`/viewer/api/handler`
 * with a custom `request: 'download'` body) that doesn't exist — pi-direct
 * never worked.
 *
 * This file makes pi-direct ACTUALLY work by adding the missing server
 * side: a real download endpoint on the Pi, served by pi-cache (not AvNav,
 * because AvNav has no "download from URL" feature). The Pi has reliable
 * internet, no iOS WebView restrictions, and can stream large files (1GB+
 * NOAA chart packs) to disk without memory pressure.
 *
 * Endpoints
 * ─────────
 *   POST /api/charts/download
 *     body: { url: string, name: string }
 *     → starts an async download, returns { jobId, status: 'pending' }
 *
 *   GET /api/charts/jobs/:id
 *     → returns the current job state for polling progress
 *
 *   GET /api/charts/jobs
 *     → lists all known jobs (debugging)
 *
 *   GET /api/charts/local
 *     → lists installed charts in CHART_DIR
 *
 *   DELETE /api/charts/local/:name
 *     → removes a local chart file
 *
 * Storage
 * ───────
 * Charts land in CHART_DIR (env, default `/var/lib/avnav/charts`) — that's
 * the directory AvNav scans automatically, so newly downloaded charts
 * appear in the AvNav viewer without restart. The directory must be
 * writable by whichever user runs pi-cache (typically `skipper`); the
 * install.sh sets group-writable + adds skipper to the avnav group.
 *
 * Job state lives in-memory only — completed jobs purge after 1 hour.
 * Downloads use unique adjacent partial files and atomically replace only
 * after the bounded stream completes. No persistent queue / resume — chart
 * installs are infrequent and a one-shot retry is fine.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normaliseOutboundHttpUrl, outboundFetch } from '../outboundHttp.js';
import {
    CHART_ARCHIVE_POLICY,
    CHART_DOWNLOAD_POLICY,
    PiResourceBoundaryError,
    extractZipArchive,
    streamResponseToFile,
} from '../resourceBoundary.js';
import { PiWorkloadBusyError, piWorkloadGovernor, workloadBusyPayload } from '../workloadGovernor.js';

interface ChartJob {
    id: string;
    url: string;
    name: string;
    status: 'pending' | 'downloading' | 'done' | 'error';
    progress: number; // 0..1
    bytesTransferred: number;
    bytesTotal: number;
    error?: string;
    errorCode?: string;
    startedAt: number;
    completedAt?: number;
    /** Final file path on disk (only set when done) */
    filePath?: string;
}

const jobs = new Map<string, ChartJob>();

const CHART_DIR = process.env.CHART_DIR || '/var/lib/avnav/charts';
const CHART_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

// Purge old completed/errored jobs every hour so the in-memory map
// doesn't grow unbounded across long-running pi-cache instances.
const JOB_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.completedAt && now - job.completedAt > JOB_TTL_MS) {
            jobs.delete(id);
        }
    }
}, JOB_TTL_MS).unref();

export function createChartRoutes(): Router {
    const router = Router();

    /**
     * POST /api/charts/download
     * Kicks off a Pi-side download. Returns immediately with a jobId;
     * the actual download runs async in the background.
     */
    router.post('/download', (req: Request, res: Response) => {
        const { url, name } = req.body || {};
        if (!url || typeof url !== 'string' || !name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Body must include {url, name}' });
        }

        // Canonicalise structure here for an immediate 400. DNS/private-range
        // enforcement happens again at the actual connection in outboundFetch.
        let parsedUrl: URL;
        try {
            parsedUrl = normaliseOutboundHttpUrl(url);
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // Sanitise filename — strip path separators and non-printable junk.
        // Keeps alphanumerics, dots, dashes, underscores. That's enough for
        // chart packages whose filenames look like `ncds_01a.mbtiles` or
        // `nz_chart_pack.zip`.
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName || safeName === '.' || safeName === '..') {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const jobId = randomUUID();
        const job: ChartJob = {
            id: jobId,
            url: parsedUrl.href,
            name: safeName,
            status: 'pending',
            progress: 0,
            bytesTransferred: 0,
            bytesTotal: 0,
            startedAt: Date.now(),
        };
        let submission;
        try {
            submission = piWorkloadGovernor.submit('conversion', () => runDownload(job));
        } catch (error) {
            if (error instanceof PiWorkloadBusyError) {
                res.setHeader('Retry-After', String(error.retryAfterSeconds));
                return res.status(error.status).json(workloadBusyPayload(error));
            }
            throw error;
        }
        jobs.set(jobId, job);

        // Run in background — the response below resolves immediately so
        // the client can switch to polling /jobs/:id for progress.
        void submission.completion.catch((err) => {
            job.status = 'error';
            job.error = err instanceof Error ? err.message : String(err);
            job.errorCode = err instanceof PiResourceBoundaryError ? err.code : undefined;
            job.completedAt = Date.now();
        });

        return res.json({ jobId, status: 'pending' });
    });

    /**
     * GET /api/charts/jobs/:id — poll endpoint. Returns the current job
     * state. Client polls every ~2s while status is 'downloading'.
     */
    router.get('/jobs/:id', (req: Request, res: Response) => {
        // Express 5 types req.params values as string | string[]; for a
        // simple :id route they're always string, but TS can't prove that.
        const id = req.params.id;
        if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' });
        const job = jobs.get(id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        return res.json(job);
    });

    /** GET /api/charts/jobs — debugging list of all in-memory jobs. */
    router.get('/jobs', (_req: Request, res: Response) => {
        return res.json({ jobs: Array.from(jobs.values()) });
    });

    /** GET /api/charts/local — list charts currently installed. */
    router.get('/local', async (_req: Request, res: Response) => {
        try {
            await fs.mkdir(CHART_DIR, { recursive: true });
            const entries = await fs.readdir(CHART_DIR);
            const charts = await Promise.all(
                entries.map(async (name) => {
                    try {
                        const stat = await fs.stat(path.join(CHART_DIR, name));
                        if (!stat.isFile()) return null;
                        return { name, size: stat.size, mtime: stat.mtimeMs };
                    } catch {
                        return null;
                    }
                }),
            );
            return res.json({
                chartDir: CHART_DIR,
                charts: charts.filter((c): c is { name: string; size: number; mtime: number } => c !== null),
            });
        } catch (err) {
            return res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    /** DELETE /api/charts/local/:name — remove a local chart file. */
    router.delete('/local/:name', async (req: Request, res: Response) => {
        const rawName = req.params.name;
        if (typeof rawName !== 'string') return res.status(400).json({ error: 'Invalid filename' });
        const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName || safeName === '.' || safeName === '..') {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        try {
            await fs.unlink(path.join(CHART_DIR, safeName));
            return res.json({ ok: true, deleted: safeName });
        } catch (err) {
            return res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    return router;
}

/**
 * Background worker that actually performs the download. Called once per
 * job (via runDownload(job).catch(...)) and updates the job object in
 * place — clients reading /jobs/:id will see the new state on next poll.
 */
async function runDownload(job: ChartJob): Promise<void> {
    job.status = 'downloading';

    await fs.mkdir(CHART_DIR, { recursive: true });
    const filePath = path.join(CHART_DIR, job.name);
    let downloadCommitted = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHART_DOWNLOAD_TIMEOUT_MS);

    try {
        const response = await outboundFetch(job.url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} from ${job.url}`);
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (Number.isSafeInteger(contentLength) && contentLength > 0) job.bytesTotal = contentLength;
        await streamResponseToFile(response, filePath, CHART_DOWNLOAD_POLICY, {
            signal: controller.signal,
            mode: 0o644,
            onProgress(bytes, total) {
                job.bytesTransferred = bytes;
                if (total > 0) job.bytesTotal = total;
                job.progress = total > 0 ? Math.min(bytes / total, 0.99) : 0.5;
            },
        });
        downloadCommitted = true;

        // ── Auto-extract zip packages ────────────────────────────────
        // Community chart packs (e.g. Bruce Balan's New Caledonia from
        // MediaFire) ship as .zip containing one or more .mbtiles files.
        // AvNav's chart scanner only recognises raw .mbtiles/.gemf/.kap
        // /.bsb/.xml on disk — it does NOT extract zips. Without this
        // step the download "succeeds" but the chart never appears in
        // the AvNav viewer (or in Thalassa's chart layer FAB).
        //
        // We extract the chart-shaped entries into CHART_DIR (flattened
        // — directory structure inside the zip is dropped, basename
        // wins) and delete the original .zip. Unsafe or over-budget
        // archives fail the job and are removed.
        const finalPath = await maybeExtractZip(job.name, filePath);

        job.status = 'done';
        job.progress = 1;
        job.completedAt = Date.now();
        job.filePath = finalPath;
        // If we never knew bytesTotal up-front, set it now from what we
        // actually transferred so clients see a clean 100% / matching
        // numerator + denominator.
        if (job.bytesTotal === 0) job.bytesTotal = job.bytesTransferred;
    } catch (err) {
        // Clean up the partial file — leaving a half-written .mbtiles
        // would make AvNav think a corrupted chart is installed.
        if (downloadCommitted) await fs.unlink(filePath).catch(() => {});
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Chart file extensions that AvNav recognises on its own. If a zip
 * contains entries with these extensions we extract them; everything
 * else (READMEs, screenshots, license PDFs) is dropped.
 *
 * `.xml` is included because o-charts / OpenCPN distributions sometimes
 * ship a chartlist.xml alongside .kap files.
 */
const CHART_EXTENSIONS = new Set(['.mbtiles', '.gemf', '.kap', '.bsb', '.xml']);

/**
 * If `name` is a `.zip`, extract the chart-shaped entries inside into
 * CHART_DIR and delete the original. Returns the path that should be
 * recorded as the final job.filePath. Inspection covers every archive entry
 * before any selected chart is inflated.
 */
async function maybeExtractZip(name: string, filePath: string): Promise<string> {
    if (!name.toLowerCase().endsWith('.zip')) return filePath;
    const extracted = await extractZipArchive(filePath, CHART_DIR, CHART_ARCHIVE_POLICY, {
        select: (entry) => CHART_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
        outputName(entry) {
            const safeBase = path.basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            return !safeBase || safeBase === '.' || safeBase === '..' ? null : safeBase;
        },
        fileMode: 0o644,
    });
    if (extracted.files.length === 0) throw new Error(`ZIP ${name} contained no recognised chart files`);

    // Extraction worked — drop the original .zip so AvNav's chart
    // scanner doesn't see both the package and its contents.
    await fs.unlink(filePath).catch((error) => {
        console.warn(`[charts] Extracted ${name}, but could not remove the source ZIP:`, error);
    });
    console.log(`[charts] Extracted ${extracted.files.length} chart file(s) from ${name}`);
    return extracted.files[0]!;
}
