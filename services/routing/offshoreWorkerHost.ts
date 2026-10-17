/** One disposable Worker per model. Cancellation and failures never run heavy compute on the page. */
import { ROUTE_ENGINE, type RouteWorkerReply } from './routeJob';
import { prepareOffshoreJob, type OffshoreJob, type OffshoreCandidate } from './offshoreProtocol';
import type { OffshoreProgress } from '../isochrone/offshoreKernel';

let sequence = 0;
export interface OffshoreHostOptions {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    onProgress?: (progress: OffshoreProgress) => void;
}
export function runOffshoreHosted(
    input: OffshoreJob,
    opts: OffshoreHostOptions = {},
): Promise<OffshoreCandidate | null> {
    return new Promise((resolve, reject) => {
        let worker: Worker | undefined,
            settled = false,
            posted = false;
        let readyTimer: ReturnType<typeof setTimeout> | undefined;
        let clock: ReturnType<typeof setInterval> | undefined;
        const id = ++sequence;
        const finish = (error?: Error, result: OffshoreCandidate | null = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(readyTimer);
            clearInterval(clock);
            opts.signal?.removeEventListener('abort', abort);
            if (worker) {
                worker.onmessage = null;
                worker.onerror = null;
                try {
                    worker.terminate();
                } catch {
                    /* Already stopped. */
                }
            }
            if (error) reject(error);
            else resolve(result);
        };
        const abort = () => finish(new DOMException('Offshore comparison stopped', 'AbortError'));
        const live = () => !opts.signal?.aborted && (opts.isCurrent?.() ?? true) && Date.now() < input.deadlineMs;
        try {
            if (!live()) {
                abort();
                return;
            }
            if (typeof Worker !== 'function') throw new Error('Offshore comparison Worker unavailable');
            const job = prepareOffshoreJob(input);
            worker = new Worker(ROUTE_ENGINE.url, { type: 'module' });
            opts.signal?.addEventListener('abort', abort, { once: true });
            clock = setInterval(() => {
                if (!live()) abort();
            }, 100);
            readyTimer = setTimeout(
                () => finish(new Error('Offshore comparison Worker did not start')),
                Math.min(10_000, Math.max(1, input.deadlineMs - Date.now())),
            );
            worker.onerror = () => finish(new Error('Offshore comparison Worker failed'));
            worker.onmessage = (event: MessageEvent<RouteWorkerReply>) => {
                if (settled) return;
                if (!live()) {
                    abort();
                    return;
                }
                const data = event.data;
                if (data.type === 'ready' && !posted) {
                    posted = true;
                    clearTimeout(readyTimer);
                    try {
                        worker!.postMessage({ type: 'offshore', id, job });
                    } catch {
                        finish(new Error('Offshore comparison could not be posted'));
                    }
                } else if (data.type === 'init-error') finish(new Error(data.message));
                else if ('id' in data && data.id === id) {
                    if (data.type === 'offshore') finish(undefined, data.candidate);
                    else if (data.type === 'offshore-progress') opts.onProgress?.(data.progress);
                    else if (data.type === 'error') finish(new Error(data.message));
                }
            };
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
