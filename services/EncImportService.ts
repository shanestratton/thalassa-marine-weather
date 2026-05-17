/**
 * ENC Import Service — device-side client for the Pi's
 * `/api/enc/*` conversion pipeline.
 *
 * Flow:
 *   1. User picks a `.000` file via the native picker (`pickEncFile`).
 *   2. We POST the raw bytes to `${piCache.baseUrl}/api/enc/convert`
 *      with `X-Filename: <original-name>`. Pi returns `{jobId}`.
 *   3. We poll `${piCache.baseUrl}/api/enc/jobs/:id` until the
 *      job completes or errors. (Conversion runs `ogr2ogr` for
 *      each layer of interest — usually 5–30 seconds total.)
 *   4. On success, we GET `/api/enc/result/:id`, hand the parsed
 *      EncConversionResult to EncHazardService.importCell, and
 *      DELETE the job to free Pi temp files.
 *   5. The cell is now indexed and ready for the routing
 *      validator to use.
 *
 * Failure modes we handle explicitly:
 *   - Pi unreachable (boat WiFi lost mid-import)
 *   - GDAL not installed on Pi (`/api/enc/health` will say so)
 *   - File rejected by Pi (oversize, malformed, not S-57)
 *   - Conversion error mid-job (corrupt cell, missing layers)
 *   - Storage error on device (out of disk space)
 *
 * Public API:
 *   pickEncFile()                → File | null (native picker)
 *   isLikelyEncFile(file)        → quick heuristic
 *   checkPiHasGdal()             → ok | error message
 *   importEncCell(file, onProgress) → EncCell
 */

import { CapacitorHttp } from '@capacitor/core';

import { createLogger } from '../utils/createLogger';
import { piCache } from './PiCacheService';
import * as EncHazardService from './enc/EncHazardService';
import type { EncCell, EncConversionBatch, EncConversionResult } from './enc/types';

const log = createLogger('EncImportService');

// ── Types ──────────────────────────────────────────────────────────

export type EncImportPhase = 'reading' | 'uploading' | 'converting' | 'fetching' | 'storing' | 'done' | 'error';

export interface EncImportProgress {
    phase: EncImportPhase;
    /** 0..1 for the overall flow. */
    progress: number;
    /** Human-readable step ("converting DEPARE", "polling Pi", ...). */
    step?: string;
    /** Filled when phase === 'error'. */
    error?: string;
    /** Filled once the cell ID has been determined. */
    cellId?: string;
    /** For UI: cell bbox once conversion has read it. */
    bbox?: [number, number, number, number];
    /** For ZIP / batch uploads: total cells in the archive (Pi-reported). */
    cellCount?: number;
    /** Cells the Pi has finished converting (ramps to cellCount). */
    cellsDone?: number;
}

/**
 * Per-cell error captured during a batch import. The user sees
 * these in the import UI's "skipped cells" footer alongside the
 * successful imports.
 */
export interface EncImportSkipped {
    filename: string;
    error: string;
}

/**
 * Result of a batch import. For single-cell uploads `cells` is
 * length 1. For ZIP uploads it can be many.
 */
export interface EncImportSummary {
    cells: EncCell[];
    skipped: EncImportSkipped[];
}

// ── Constants ──────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
/** 10 minutes — enough for a large port cell with thousands of features. */
const POLL_MAX_ATTEMPTS = 300;

// ── File picker ───────────────────────────────────────────────────

/**
 * Open the native file picker filtered to S-57 cells. Returns the
 * selected File, or null if the user cancelled.
 *
 * Uses the same hidden-`<input type="file">` pattern as
 * ChartLockerService — works on iOS Capacitor.
 *
 * Note: iOS doesn't recognise `.000` as a registered filetype; we
 * also accept `application/octet-stream` so the picker doesn't grey
 * out cells. The filename suffix check in `isLikelyEncFile` runs
 * after pick to catch users who select the wrong file.
 */
export function pickEncFile(): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        // S-57 sequential update files are .001/.002/etc — we accept
        // them too so the user can re-import a cell + its updates as
        // one operation. (Phase 2 just consumes the .000; Phase 3
        // can apply updates server-side.)
        input.accept = '.000,.001,.002,.003,.004,.005,.006,.007,.008,.009,.zip,application/octet-stream';
        input.style.display = 'none';
        document.body.appendChild(input);

        input.addEventListener('change', () => {
            const file = input.files?.[0] ?? null;
            document.body.removeChild(input);
            if (file) {
                log.info(`[Pick] Selected ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
            }
            resolve(file);
        });

        input.addEventListener('cancel', () => {
            document.body.removeChild(input);
            resolve(null);
        });

        input.click();
    });
}

/**
 * Heuristic check that a picked file is plausibly an ENC cell.
 * Used to surface an early "this doesn't look right" message
 * before we waste the user's time uploading.
 */
export function isLikelyEncFile(file: File): boolean {
    const lower = file.name.toLowerCase();
    if (/\.000$/.test(lower)) return true;
    // S-57 update files (.001..009) are also valid imports.
    if (/\.00[1-9]$/.test(lower)) return true;
    // ZIP containing ENC_ROOT — Phase 2 doesn't unzip server-side
    // but we accept the picker so users don't get confused.
    if (lower.endsWith('.zip')) return true;
    return false;
}

// ── Pi health check ───────────────────────────────────────────────

/**
 * Verify the Pi has GDAL installed before we kick off an import.
 * Returns null if everything is fine, or a user-facing error
 * message describing what's wrong.
 */
export async function checkPiHasGdal(): Promise<string | null> {
    if (!piCache.isAvailable()) {
        return 'Pi cache not reachable. Connect to your boat WiFi and toggle Pi Cache on in Boat Network settings.';
    }
    try {
        const res = await CapacitorHttp.get({
            url: `${piCache.baseUrl}/api/enc/health`,
            connectTimeout: 5000,
            readTimeout: 5000,
        });
        if (res.status === 404) {
            return 'This Pi cache is too old — needs the ENC integration update.';
        }
        if (res.status >= 200 && res.status < 300) return null;

        const data = res.data as { error?: string; detail?: string } | string | undefined;
        if (typeof data === 'object' && data?.error) return data.error;
        return `Pi responded ${res.status} — ENC support may be missing.`;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Could not reach Pi for ENC health check: ${msg}`;
    }
}

// ── Import flow ───────────────────────────────────────────────────

/**
 * Main import path. Reads the file, ships it to the Pi, polls for
 * the conversion result, and writes the converted GeoJSON into
 * EncHazardService.
 *
 * The flow is broken into observable phases (`onProgress`) so the
 * import UI can show a meaningful progress bar instead of an
 * indeterminate spinner.
 *
 * Throws on unrecoverable errors. Caller should display the
 * thrown message; the same message is also sent via
 * `onProgress({phase: 'error', error: ...})` first.
 */
export async function importEncCell(
    file: File | Blob,
    onProgress?: (p: EncImportProgress) => void,
): Promise<EncImportSummary> {
    const filename = file instanceof File ? file.name : 'cell.000';

    const emit = (p: EncImportProgress): void => {
        try {
            onProgress?.(p);
        } catch (err) {
            log.warn('progress callback threw', err);
        }
    };

    if (!piCache.isAvailable()) {
        const error = 'Pi cache not reachable. Connect to your boat WiFi and try again.';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    const piBase = piCache.baseUrl;

    // ── 1. Read bytes ─────────────────────────────────────────────
    emit({ phase: 'reading', progress: 0.05, step: `reading ${filename}` });

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
        const error = 'File is empty';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }
    log.info(`[Import] Read ${(buffer.byteLength / 1024).toFixed(1)} KB from ${filename}`);

    // ── 2. POST to Pi ─────────────────────────────────────────────
    emit({ phase: 'uploading', progress: 0.15, step: `uploading to Pi (${piBase})` });

    let jobId: string;
    try {
        // Convert ArrayBuffer to base64 for CapacitorHttp transport.
        // CapacitorHttp on iOS uses URLSession for native plain
        // requests, but binary bodies have historically been finicky;
        // base64 + Content-Transfer-Encoding header is the safe path.
        const base64 = arrayBufferToBase64(buffer);

        // Send the base64 string as the body and tell the Pi to
        // decode it back to bytes before processing. This is the
        // most reliable cross-Capacitor binary upload path —
        // CapacitorHttp's binary data handling has historical
        // quirks across iOS/Android/web; ASCII base64 always works.
        const res = await CapacitorHttp.post({
            url: `${piBase}/api/enc/convert`,
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Filename': filename,
                'X-Body-Encoding': 'base64',
            },
            data: base64,
            connectTimeout: 10000,
            readTimeout: 60000,
        });

        if (res.status < 200 || res.status >= 300) {
            const detail =
                typeof res.data === 'object' && res.data && 'error' in res.data
                    ? (res.data as { error?: string }).error
                    : `HTTP ${res.status}`;
            throw new Error(`Pi rejected upload: ${detail}`);
        }

        const data = res.data as { jobId?: string } | undefined;
        if (!data || typeof data.jobId !== 'string') {
            throw new Error('Pi did not return a job ID');
        }
        jobId = data.jobId;
        log.info(`[Import] Pi accepted upload — jobId=${jobId}`);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    // ── 3-6. Poll → fetch → persist ────────────────────────────────
    // Shared with installEncFromUrl / syncEncFromPi via the helper.
    return pollAndFetchAndStore(piBase, jobId, emit);
}

// ── Pi-server install (Phase 11) ──────────────────────────────────

/**
 * Pi-side metadata record for an installed cell. Mirrors the shape
 * returned by `GET /api/enc/installed`.
 */
export interface PiInstalledCell {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
    installedAt: string;
    source: 'phone-upload' | 'url';
    sourceUrl?: string;
}

/**
 * Install a chart on the Pi by URL. Pi downloads from the URL,
 * runs through the same GDAL conversion pipeline as a phone
 * upload, and persists every successfully-converted cell to its
 * chart store.
 *
 * The flow is identical to importEncCell from the polling
 * standpoint — same job/poll/result endpoints — so we share the
 * progress + result-handling code.
 */
export async function installEncFromUrl(
    url: string,
    filename: string | undefined,
    onProgress?: (p: EncImportProgress) => void,
): Promise<EncImportSummary> {
    const emit = (p: EncImportProgress): void => {
        try {
            onProgress?.(p);
        } catch (err) {
            log.warn('progress callback threw', err);
        }
    };

    if (!piCache.isAvailable()) {
        const error = 'Pi cache not reachable. Connect to your boat WiFi and try again.';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    const piBase = piCache.baseUrl;

    emit({ phase: 'uploading', progress: 0.05, step: 'asking Pi to download chart' });

    let jobId: string;
    try {
        const res = await CapacitorHttp.post({
            url: `${piBase}/api/enc/install-from-url`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ url, filename }),
            connectTimeout: 5000,
            readTimeout: 15000,
        });
        if (res.status < 200 || res.status >= 300) {
            const detail =
                typeof res.data === 'object' && res.data && 'error' in res.data
                    ? (res.data as { error?: string }).error
                    : `HTTP ${res.status}`;
            throw new Error(`Pi rejected install request: ${detail}`);
        }
        const data = res.data as { jobId?: string } | undefined;
        if (!data || typeof data.jobId !== 'string') throw new Error('Pi did not return a job ID');
        jobId = data.jobId;
        log.info(`[InstallFromUrl] Pi accepted — jobId=${jobId}`);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    // Drain the existing poll/fetch/persist pipeline. We reuse
    // pollAndFetchAndStore so the URL-install path and the upload
    // path share progress UX + skipped-cells handling identically.
    return pollAndFetchAndStore(piBase, jobId, emit);
}

/**
 * Pull every Pi-installed cell that isn't already on the device.
 * Used by the "Sync from Pi" button and on first launch when the
 * phone has localStorage cleared but the Pi still holds charts.
 *
 * For each cell:
 *   1. If already in device localStorage and edition matches: skip.
 *   2. Otherwise GET /api/enc/installed/:cellId/data and run
 *      EncHazardService.importCell on the result.
 */
export interface SyncEncFromPiOptions {
    /**
     * Lat/lon to prioritise pulls around — nearest-first ordering. Typically
     * the user's current GPS position; falls back to vessel home port if GPS
     * is unavailable. If omitted, cells are pulled in the Pi's listing order
     * (alphabetical by cellId).
     */
    priorityCenter?: { lat: number; lon: number };
    /**
     * Soft cap on cells pulled in this sync run. The remaining cells stay on
     * the Pi and are pulled on subsequent runs (or when the user moves into
     * a new region). Use 0 / undefined for "pull everything reachable".
     */
    maxCells?: number;
}

export async function syncEncFromPi(
    onProgress?: (p: EncImportProgress) => void,
    options: SyncEncFromPiOptions = {},
): Promise<EncImportSummary> {
    const emit = (p: EncImportProgress): void => {
        try {
            onProgress?.(p);
        } catch (err) {
            log.warn('progress callback threw', err);
        }
    };

    if (!piCache.isAvailable()) {
        const error = 'Pi cache not reachable. Connect to your boat WiFi and try again.';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    const piBase = piCache.baseUrl;
    emit({ phase: 'fetching', progress: 0.05, step: 'asking Pi for installed charts' });

    let installed: PiInstalledCell[];
    try {
        const res = await CapacitorHttp.get({
            url: `${piBase}/api/enc/installed`,
            connectTimeout: 5000,
            readTimeout: 10000,
            responseType: 'json',
        });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        installed = ((res.data as { cells?: PiInstalledCell[] })?.cells ?? []) as PiInstalledCell[];
    } catch (err) {
        const error = `Failed to list Pi charts: ${err instanceof Error ? err.message : String(err)}`;
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    if (installed.length === 0) {
        emit({ phase: 'done', progress: 1, step: 'Pi has no charts installed' });
        return { cells: [], skipped: [] };
    }

    // Skip cells we already have locally at the same edition.
    const localCellIds = new Set(EncHazardService.getCoverage().map((c) => `${c.id}@${c.edition}`));
    let toFetch = installed.filter((c) => !localCellIds.has(`${c.cellId}@${c.edition}`));

    if (toFetch.length === 0) {
        emit({
            phase: 'done',
            progress: 1,
            step: `already in sync (${installed.length} cells)`,
            cellCount: installed.length,
            cellsDone: installed.length,
        });
        return { cells: [], skipped: [] };
    }

    // Priority ordering — nearest-cell-first when the caller passed a centre
    // (typically current GPS). Each cell's distance is computed against its
    // bbox centroid; if a cell already contains the priority point, distance
    // is zero so it sorts to the top. This means a punter who launches the
    // app at the dock gets the harbour-band cell first, then the approach,
    // then the overview, then everything else.
    //
    // Without a priority centre we keep the Pi's listing order (alphabetic),
    // which is fine for "give me everything" manual syncs.
    if (options.priorityCenter) {
        const { lat: pLat, lon: pLon } = options.priorityCenter;
        const distance = (c: PiInstalledCell): number => {
            const [wLon, sLat, eLon, nLat] = c.bbox;
            if (pLat >= sLat && pLat <= nLat && pLon >= wLon && pLon <= eLon) return 0;
            const cLat = (sLat + nLat) / 2;
            const cLon = (wLon + eLon) / 2;
            const dLat = (pLat - cLat) * 111; // ~km per degree latitude
            const dLon = (pLon - cLon) * 111 * Math.cos((pLat * Math.PI) / 180);
            return Math.hypot(dLat, dLon);
        };
        toFetch = [...toFetch].sort((a, b) => distance(a) - distance(b));
        log.warn(
            `priority-sorted ${toFetch.length} cells around (${pLat.toFixed(3)}, ${pLon.toFixed(3)}); first 3: ${toFetch
                .slice(0, 3)
                .map((c) => c.cellId)
                .join(', ')}`,
        );
    }

    // Soft cap — caller can ask "give me the nearest N and we'll get the rest
    // next launch." Auto-sync sets this; manual sync leaves it unlimited.
    if (options.maxCells && options.maxCells > 0 && toFetch.length > options.maxCells) {
        log.warn(
            `capping sync at ${options.maxCells} nearest cells (${toFetch.length - options.maxCells} deferred to next run)`,
        );
        toFetch = toFetch.slice(0, options.maxCells);
    }

    const persisted: EncCell[] = [];
    const skipped: EncImportSkipped[] = [];

    for (let i = 0; i < toFetch.length; i++) {
        const remote = toFetch[i];
        emit({
            phase: 'fetching',
            progress: 0.1 + ((i + 1) / toFetch.length) * 0.85,
            step: `pulling ${remote.cellId} (${i + 1}/${toFetch.length})`,
            cellCount: toFetch.length,
            cellsDone: i,
            cellId: remote.cellId,
            bbox: remote.bbox,
        });
        try {
            const res = await CapacitorHttp.get({
                url: `${piBase}/api/enc/installed/${encodeURIComponent(remote.cellId)}/data`,
                connectTimeout: 10000,
                readTimeout: 120000,
                responseType: 'json',
            });
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`HTTP ${res.status} fetching cell data`);
            }
            const blob = res.data as EncConversionBatch;
            if (!blob || !Array.isArray(blob.cells) || blob.cells.length === 0) {
                throw new Error('Pi returned malformed cell data');
            }
            // Each Pi cell file holds one cell, but the wire format
            // is the {cells: [...]} envelope so a future multi-cell
            // bundle would also work.
            for (const conversion of blob.cells) {
                const cell = await EncHazardService.importCell(conversion);
                persisted.push(cell);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[SyncFromPi] cell ${remote.cellId} failed`, err);
            skipped.push({ filename: remote.cellId, error: msg });
        }
    }

    emit({
        phase: 'done',
        progress: 1,
        step:
            persisted.length === 1
                ? `synced ${persisted[0].id}`
                : `synced ${persisted.length} cells${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
        cellCount: toFetch.length,
        cellsDone: persisted.length,
    });
    return { cells: persisted, skipped };
}

/**
 * Pi-side: ask the Pi which charts it has installed. Cheap call,
 * just metadata; safe to use for "is there anything to sync?"
 * checks.
 */
export async function listPiInstalledCharts(): Promise<PiInstalledCell[]> {
    if (!piCache.isAvailable()) return [];
    try {
        const res = await CapacitorHttp.get({
            url: `${piCache.baseUrl}/api/enc/installed`,
            connectTimeout: 3000,
            readTimeout: 5000,
            responseType: 'json',
        });
        if (res.status < 200 || res.status >= 300) return [];
        return ((res.data as { cells?: PiInstalledCell[] })?.cells ?? []) as PiInstalledCell[];
    } catch (err) {
        log.warn('listPiInstalledCharts failed', err);
        return [];
    }
}

/**
 * Internal helper shared by `importEncCell` and `installEncFromUrl`.
 * Polls a job until done, fetches the result, and writes each cell
 * into EncHazardService.
 */
interface PiJobStatus {
    status: string;
    progress?: number;
    step?: string;
    error?: string;
    cellId?: string;
    bbox?: [number, number, number, number];
    cellCount?: number;
    cellsDone?: number;
}

async function pollAndFetchAndStore(
    piBase: string,
    jobId: string,
    emit: (p: EncImportProgress) => void,
): Promise<EncImportSummary> {
    let lastJobState: PiJobStatus | null = null;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let res;
        try {
            res = await CapacitorHttp.get({
                url: `${piBase}/api/enc/jobs/${jobId}`,
                connectTimeout: 5000,
                readTimeout: 10000,
            });
        } catch (err) {
            log.warn(`[Poll] attempt ${attempt} failed`, err);
            continue;
        }
        if (res.status === 404) {
            const error = 'Pi lost the conversion job (server may have restarted)';
            emit({ phase: 'error', progress: 0, error });
            throw new Error(error);
        }
        if (res.status < 200 || res.status >= 300) continue;
        const job = res.data as PiJobStatus | null;
        if (!job) continue;
        lastJobState = job;
        if (job.status === 'done') {
            emit({
                phase: 'fetching',
                progress: 0.85,
                step: 'fetching converted cells from Pi',
                cellId: job.cellId,
                bbox: job.bbox,
                cellCount: job.cellCount,
                cellsDone: job.cellsDone,
            });
            break;
        }
        if (job.status === 'error') {
            const error = job.error || 'Pi reported conversion failed';
            emit({ phase: 'error', progress: 0, error });
            throw new Error(error);
        }
        const piProgress = typeof job.progress === 'number' ? job.progress : 0;
        emit({
            phase: 'converting',
            progress: 0.05 + piProgress * 0.8,
            step: job.step ?? `Pi: ${job.status}`,
            cellId: job.cellId,
            bbox: job.bbox,
            cellCount: job.cellCount,
            cellsDone: job.cellsDone,
        });
    }

    if (!lastJobState || lastJobState.status !== 'done') {
        const error = 'Conversion timed out — Pi did not finish in 10 minutes';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    let batch: EncConversionBatch;
    try {
        const res = await CapacitorHttp.get({
            url: `${piBase}/api/enc/result/${jobId}`,
            connectTimeout: 10000,
            readTimeout: 180000,
            responseType: 'json',
        });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching result`);
        const raw = res.data as EncConversionBatch | EncConversionResult;
        if ('cells' in raw && Array.isArray(raw.cells)) batch = raw;
        else if ('cellId' in raw) batch = { cells: [raw as EncConversionResult] };
        else throw new Error('Pi returned malformed conversion result');
        if (batch.cells.length === 0) throw new Error('Pi returned an empty cell list');
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    const persisted: EncCell[] = [];
    const persistFailures: EncImportSkipped[] = [];
    for (let i = 0; i < batch.cells.length; i++) {
        const conversion = batch.cells[i];
        emit({
            phase: 'storing',
            progress: 0.86 + (0.13 * (i + 1)) / batch.cells.length,
            step: `saving ${conversion.cellId} (${i + 1}/${batch.cells.length})`,
            cellId: conversion.cellId,
            cellCount: batch.cells.length,
            cellsDone: i,
        });
        try {
            const cell = await EncHazardService.importCell(conversion);
            persisted.push(cell);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            persistFailures.push({ filename: conversion.cellId, error: msg });
        }
    }
    if (persisted.length === 0) {
        const error = 'All cells failed to save on device';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    void CapacitorHttp.delete({ url: `${piBase}/api/enc/jobs/${jobId}` }).catch(() => {});

    const skipped: EncImportSkipped[] = [...(batch.skipped ?? []), ...persistFailures];
    emit({
        phase: 'done',
        progress: 1,
        step:
            persisted.length === 1
                ? `imported ${persisted[0].id}`
                : `imported ${persisted.length} cells${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
        cellId: persisted[0].id,
        bbox: persisted[0].bbox,
        cellCount: batch.cells.length,
        cellsDone: persisted.length,
    });
    return { cells: persisted, skipped };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Convert ArrayBuffer to base64 string for CapacitorHttp body
 * transport. Iterates in chunks to avoid blowing the JS call
 * stack with `String.fromCharCode(...largeArray)`.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, Array.from(slice));
    }
    return btoa(binary);
}
