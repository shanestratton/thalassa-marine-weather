import { GRIB_IMPORT_LIMITS as GRIB1_LIMITS, GribImportError, type ImportedGribFile } from './gribImportTypes';
import { gribEdition } from './decodeGrib1Wind';
import type { GribImportReply } from './gribImportProtocol';

export interface GribDecodeWorker {
    onmessage: ((event: MessageEvent<GribImportReply>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage: (message: unknown, transfer: Transferable[]) => void;
    terminate: () => void;
}
let sequence = 0;
/** Owns/transfers the buffer only after Worker readiness. Cancellation always terminates; no page-thread fallback. */
export function decodeGribInWorker(
    buffer: ArrayBuffer,
    options: {
        signal?: AbortSignal;
        isCurrent?: () => boolean;
        timeoutMs?: number;
        workerFactory?: () => GribDecodeWorker;
    } = {},
): Promise<ImportedGribFile> {
    return new Promise((resolve, reject) => {
        let worker: GribDecodeWorker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let stale: ReturnType<typeof setInterval> | undefined,
            settled = false,
            posted = false;
        const id = ++sequence;
        const current = () => !options.signal?.aborted && (options.isCurrent?.() ?? true);
        const finish = (error?: Error, grid?: ImportedGribFile) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(stale);
            options.signal?.removeEventListener('abort', abort);
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
            else resolve(grid!);
        };
        const abort = () => finish(new GribImportError('CANCELLED', 'GRIB import stopped.'));
        try {
            if (!current()) {
                abort();
                return;
            }
            if (buffer.byteLength > GRIB1_LIMITS.fileBytes)
                throw new GribImportError('LIMIT', 'The GRIB file exceeds the import byte limit.');
            gribEdition(buffer);
            worker =
                options.workerFactory?.() ??
                new Worker(new URL('./gribImportWorker.ts', import.meta.url), { type: 'module' });
            options.signal?.addEventListener('abort', abort, { once: true });
            const timeout = options.timeoutMs ?? 10_000;
            timer = setTimeout(
                () => finish(new GribImportError('CANCELLED', 'GRIB import exceeded its time limit.')),
                Number.isFinite(timeout) ? Math.max(1, Math.min(timeout, 10_000)) : 10_000,
            );
            stale = setInterval(() => {
                if (!current()) abort();
            }, 50);
            worker.onerror = () => finish(new GribImportError('MALFORMED', 'The GRIB decoding Worker failed.'));
            worker.onmessage = ({ data }) => {
                if (settled) return;
                if (!current()) {
                    abort();
                    return;
                }
                if (data.type === 'ready' && !posted) {
                    posted = true;
                    try {
                        worker!.postMessage({ id, buffer }, [buffer]);
                    } catch {
                        finish(new GribImportError('MALFORMED', 'The GRIB file could not be sent to the Worker.'));
                    }
                } else if ('id' in data && data.id === id && posted) {
                    if (data.type === 'decoded') finish(undefined, data.grid);
                    else if (data.type === 'error') finish(new GribImportError(data.code, data.message));
                }
            };
        } catch (error) {
            finish(error instanceof Error ? error : new Error('GRIB import failed.'));
        }
    });
}
