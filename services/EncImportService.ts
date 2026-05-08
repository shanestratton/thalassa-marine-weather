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
import type { EncCell, EncConversionResult } from './enc/types';

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
export async function importEncCell(file: File | Blob, onProgress?: (p: EncImportProgress) => void): Promise<EncCell> {
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

    // ── 3. Poll for conversion progress ────────────────────────────
    let lastJobState: {
        status: string;
        progress?: number;
        step?: string;
        cellId?: string;
        bbox?: [number, number, number, number];
    } | null = null;
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
            // Transient network blip — keep trying for a few cycles
            // before giving up.
            log.warn(`[Import] Poll attempt ${attempt} failed`, err);
            continue;
        }

        if (res.status === 404) {
            const error = 'Pi lost the conversion job (server may have restarted)';
            emit({ phase: 'error', progress: 0, error });
            throw new Error(error);
        }
        if (res.status < 200 || res.status >= 300) {
            log.warn(`[Import] Poll returned HTTP ${res.status}`);
            continue;
        }

        const job = res.data as {
            status: string;
            progress?: number;
            step?: string;
            error?: string;
            cellId?: string;
            bbox?: [number, number, number, number];
        };
        lastJobState = job;

        if (job.status === 'done') {
            // Map Pi-side progress (which goes 0..1 over the whole
            // conversion) into our 0.15..0.85 device-side window.
            emit({
                phase: 'fetching',
                progress: 0.85,
                step: 'fetching converted cell from Pi',
                cellId: job.cellId,
                bbox: job.bbox,
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
            progress: 0.15 + piProgress * 0.7,
            step: job.step ?? `Pi: ${job.status}`,
            cellId: job.cellId,
            bbox: job.bbox,
        });
    }

    if (!lastJobState || lastJobState.status !== 'done') {
        const error = 'Conversion timed out — Pi did not finish in 10 minutes';
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    // ── 4. Fetch the converted blob ───────────────────────────────
    let conversion: EncConversionResult;
    try {
        const res = await CapacitorHttp.get({
            url: `${piBase}/api/enc/result/${jobId}`,
            connectTimeout: 10000,
            readTimeout: 120000, // 2 min for very large cells
            responseType: 'json',
        });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`HTTP ${res.status} fetching result`);
        }
        conversion = res.data as EncConversionResult;
        if (!conversion || !conversion.cellId) {
            throw new Error('Pi returned malformed conversion result');
        }
        log.info(`[Import] Fetched conversion for cell ${conversion.cellId}`);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    // ── 5. Persist on device ──────────────────────────────────────
    emit({ phase: 'storing', progress: 0.92, step: 'saving to device' });

    let cell: EncCell;
    try {
        cell = await EncHazardService.importCell(conversion);
    } catch (err) {
        const error = `Failed to save cell on device: ${err instanceof Error ? err.message : String(err)}`;
        emit({ phase: 'error', progress: 0, error });
        throw new Error(error);
    }

    // ── 6. Best-effort: ask Pi to clean up its temp files ─────────
    void CapacitorHttp.delete({ url: `${piBase}/api/enc/jobs/${jobId}` }).catch(() => {});

    emit({
        phase: 'done',
        progress: 1,
        step: `imported ${cell.id}`,
        cellId: cell.id,
        bbox: cell.bbox,
    });
    log.info(`[Import] ✓ ${cell.id} (${cell.sourceHO} ed.${cell.edition}) — ${cell.hazardCount} features`);
    return cell;
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
