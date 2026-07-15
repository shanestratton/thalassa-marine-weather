/**
 * navGridWorker — runs buildNavGrid OFF the main thread.
 *
 * Born from the 2026-07-15 crash audit: buildNavGrid is a SYNCHRONOUS
 * compute measured at 1–38 s+ that froze the iOS WKWebView main thread long
 * enough for the OS watchdog to kill the app while planning a route. Off the
 * main thread it runs freely, the UI stays alive, and the ~21 MB of typed
 * arrays return zero-copy via the transfer list. The body is pure array math
 * and every import (constants/geometry/aStar/marinaCenterline, console-only
 * logging) is worker-safe — verified. If this worker ever fails to spawn or
 * throws, the host (navGridWorkerHost) falls back to the synchronous
 * buildNavGrid on the main thread, so a trace always grades.
 *
 * Mirrors services/enc/encGeometryWorker.ts (the repo's proven module-worker
 * + `new URL(..., import.meta.url)` idiom).
 *
 * IN:  { jobId, layers, bbox, resolutionM, draftM, safetyM, obstructionBufferM,
 *        relaxedLndare, relaxZones, routeProfile }
 * OUT: { jobId, type:'grid', grid }  (typed-array buffers in the transfer list)
 *      { jobId, type:'error', message }
 */
import { buildNavGrid } from './navGrid';
import type { InshoreLayers, RelaxZone } from './types';

interface NavGridJob {
    jobId: number;
    layers: InshoreLayers;
    bbox: [number, number, number, number];
    resolutionM: number;
    draftM: number;
    safetyM: number;
    obstructionBufferM: number;
    relaxedLndare?: boolean;
    relaxZones?: RelaxZone[];
    routeProfile?: 'safest' | 'tideAssist' | 'tideDirect';
}

const ctx = self as unknown as {
    onmessage: ((ev: MessageEvent<NavGridJob>) => void) | null;
    postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<NavGridJob>) => {
    const d = ev.data;
    try {
        const grid = buildNavGrid(
            d.layers,
            d.bbox,
            d.resolutionM,
            d.draftM,
            d.safetyM,
            d.obstructionBufferM,
            d.relaxedLndare ?? false,
            d.relaxZones ?? [],
            d.routeProfile ?? 'safest',
        );
        // Transfer every typed-array buffer (auto-covers the optional grid
        // fields without hardcoding). The NavGrid rehydrates on the main
        // thread as a plain object with live typed arrays — used directly.
        const transfer: ArrayBuffer[] = [];
        for (const v of Object.values(grid)) {
            if (ArrayBuffer.isView(v)) transfer.push((v as ArrayBufferView).buffer as ArrayBuffer);
        }
        ctx.postMessage({ jobId: d.jobId, type: 'grid', grid }, transfer);
    } catch (e) {
        ctx.postMessage({ jobId: d.jobId, type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
};
