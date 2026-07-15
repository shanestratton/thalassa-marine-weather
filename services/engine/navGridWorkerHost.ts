/**
 * navGridWorkerHost — main-thread side of the navGrid worker.
 *
 * `buildNavGridAsync(...)` mirrors buildNavGrid's signature but runs the heavy
 * build in navGridWorker (off the main thread, fixing the 2026-07-15 sync-freeze
 * crash). Lazy-singleton worker (mirrors EncHazardService.getGeoWorker). On
 * ANYTHING going wrong — no Worker global (SSR/old webview), spawn failure,
 * worker onerror, a thrown build, or an un-postable message — it FALLS BACK to
 * the synchronous buildNavGrid on the main thread, so a trace always grades
 * (the tracer has no "fast version" to hold, unlike the glaze worker).
 */
import { buildNavGrid } from './navGrid';
import type { InshoreLayers, NavGrid, RelaxZone } from './types';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('navGridWorkerHost');

type GridMsg = { jobId: number; type: 'grid'; grid: NavGrid } | { jobId: number; type: 'error'; message: string };

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (g: NavGrid) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
    if (broken) return null;
    if (worker) return worker;
    try {
        if (typeof Worker === 'undefined') {
            broken = true;
            return null;
        }
        worker = new Worker(new URL('./navGridWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (ev: MessageEvent<GridMsg>) => {
            const d = ev.data;
            const p = pending.get(d.jobId);
            if (!p) return;
            pending.delete(d.jobId);
            if (d.type === 'grid') p.resolve(d.grid);
            else p.reject(new Error(d.message || 'navGrid worker error'));
        };
        worker.onerror = () => {
            // The whole worker died — reject everything in flight so each
            // caller's fallback runs, and stop using the worker this session.
            broken = true;
            for (const [, p] of pending) p.reject(new Error('navGrid worker crashed'));
            pending.clear();
            try {
                worker?.terminate();
            } catch {
                /* already gone */
            }
            worker = null;
        };
    } catch {
        broken = true;
        return null;
    }
    return worker;
}

export function buildNavGridAsync(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare = false,
    relaxZones: RelaxZone[] = [],
    routeProfile: 'safest' | 'tideAssist' = 'safest',
): Promise<NavGrid> {
    const runSync = (): NavGrid =>
        buildNavGrid(
            layers,
            bbox,
            resolutionM,
            draftM,
            safetyM,
            obstructionBufferM,
            relaxedLndare,
            relaxZones,
            routeProfile,
        );

    const w = getWorker();
    if (!w) return Promise.resolve(runSync());

    const jobId = ++seq;
    return new Promise<NavGrid>((resolve, reject) => {
        pending.set(jobId, { resolve, reject });
        try {
            w.postMessage({
                jobId,
                layers,
                bbox,
                resolutionM,
                draftM,
                safetyM,
                obstructionBufferM,
                relaxedLndare,
                relaxZones,
                routeProfile,
            });
        } catch (e) {
            pending.delete(jobId);
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    }).catch((err: Error) => {
        // Any worker-side failure → synchronous fallback so grading never stalls.
        log.warn(`navGrid worker failed (${err.message}) — synchronous fallback`);
        return runSync();
    });
}
