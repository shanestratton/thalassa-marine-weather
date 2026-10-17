import type { readLocalChart, LocalChartOperation } from './localChartLibrary';
import type { LocalChartDisplay } from './localChartDisplay';
import {
    rasterBounds,
    rasterDimensions,
    rasterRequire,
    LOCAL_RASTER_BYTES,
    LOCAL_RASTER_DECODE_MS,
    type LocalRasterImage,
} from './localRasterContract';
import { LOCAL_CHART_FILE_BYTES } from './localChartLimits';
export interface LocalRasterWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: unknown, transfer: Transferable[]): void;
    terminate(): void;
}
let sequence = 0;
export function validateLocalRasterReply(value: unknown): LocalRasterImage {
    rasterRequire(
        !!value &&
            typeof value === 'object' &&
            'width' in value &&
            typeof value.width === 'number' &&
            'height' in value &&
            typeof value.height === 'number',
        'Raster chart worker returned invalid dimensions.',
    );
    rasterDimensions(value.width, value.height);
    rasterRequire(
        'rgba' in value &&
            value.rgba instanceof Uint8Array &&
            value.rgba.buffer instanceof ArrayBuffer &&
            value.rgba.byteLength === value.width * value.height * 4 &&
            value.rgba.byteLength <= LOCAL_RASTER_BYTES &&
            'bounds' in value &&
            Array.isArray(value.bounds),
        'Raster chart worker returned invalid pixels.',
    );
    rasterBounds(value.bounds);
    rasterRequire(
        'datum' in value &&
            value.datum === 'WGS84' &&
            'sourceProjection' in value &&
            ['WGS84 Mercator', 'EPSG:4326', 'EPSG:3857'].includes(String(value.sourceProjection)) &&
            'note' in value &&
            typeof value.note === 'string' &&
            value.note.length <= 300,
        'Raster chart worker returned unsupported georeferencing.',
    );
    return value as LocalRasterImage;
}
/** Readiness precedes transfer; abort/clock/currentness always terminates, with no page-thread fallback. */
export function decodeLocalRasterInWorker(
    kind: 'kap' | 'tif' | 'tiff',
    buffer: ArrayBuffer,
    options: LocalChartOperation & { workerFactory?: () => LocalRasterWorker } = {},
): Promise<LocalRasterImage> {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        let worker: LocalRasterWorker | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
        let clock: ReturnType<typeof setInterval> | undefined,
            settled = false,
            posted = false;
        const current = () => !options.signal?.aborted && options.isCurrent?.() !== false;
        const finish = (error?: Error, image?: LocalRasterImage) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(clock);
            options.signal?.removeEventListener('abort', abort);
            if (worker) {
                worker.onmessage = null;
                worker.onerror = null;
                worker.terminate();
            }
            if (error) reject(error);
            else resolve(image!);
        };
        const abort = () => finish(new Error('Local chart decoding stopped.'));
        try {
            if (!current()) {
                abort();
                return;
            }
            rasterRequire(
                buffer.byteLength >= 8 && buffer.byteLength <= LOCAL_CHART_FILE_BYTES,
                'Raster chart input exceeds its file limit.',
            );
            worker =
                options.workerFactory?.() ??
                new Worker(new URL('./localRasterWorker.ts', import.meta.url), { type: 'module' });
            options.signal?.addEventListener('abort', abort, { once: true });
            timeout = setTimeout(
                () => finish(new Error('Local chart decoding exceeded 15 seconds. Use a smaller MBTiles pyramid.')),
                LOCAL_RASTER_DECODE_MS,
            );
            clock = setInterval(() => {
                if (!current()) abort();
            }, 50);
            worker.onerror = () => finish(new Error('Local chart worker failed or was blocked by this device.'));
            worker.onmessage = ({ data }) => {
                if (settled) return;
                if (!current()) {
                    abort();
                    return;
                }
                if (!data || typeof data !== 'object' || !('type' in data)) {
                    finish(new Error('Invalid local chart worker reply.'));
                    return;
                }
                if (data.type === 'ready' && !posted) {
                    posted = true;
                    try {
                        worker!.postMessage({ id, kind, buffer }, [buffer]);
                    } catch {
                        finish(new Error('The chart bytes could not be transferred to the worker.'));
                    }
                } else if ('id' in data && data.id === id && posted) {
                    try {
                        if (data.type === 'decoded' && 'image' in data)
                            finish(undefined, validateLocalRasterReply(data.image));
                        else if (data.type === 'error' && 'message' in data && typeof data.message === 'string')
                            finish(new Error(data.message.slice(0, 400)));
                        else finish(new Error('Invalid local chart worker result.'));
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error('Invalid local chart worker output.'));
                    }
                }
            };
        } catch (error) {
            finish(error instanceof Error ? error : new Error('Local chart worker failed.'));
        }
    });
}
export async function openLocalRasterChart(
    admitted: Awaited<ReturnType<typeof readLocalChart>>,
    options: LocalChartOperation,
): Promise<LocalChartDisplay> {
    const started = performance.now();
    const check = () => {
        if (
            !admitted.isCurrent() ||
            options.signal?.aborted ||
            options.isCurrent?.() === false ||
            performance.now() - started >= LOCAL_RASTER_DECODE_MS
        )
            throw new Error('Local chart image preparation stopped or exceeded 15 seconds.');
    };
    check();
    const kind = admitted.chart.kind;
    if (kind === 'mbtiles') throw new Error('MBTiles is not a single raster image.');
    const bytes = admitted.bytes;
    const buffer =
        bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : new Uint8Array(bytes).buffer;
    const image = await decodeLocalRasterInWorker(kind, buffer, {
        signal: options.signal,
        isCurrent: admitted.isCurrent,
    });
    check();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This device cannot prepare a local chart image.');
    let blob: Blob;
    try {
        context.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
        check();
        blob = await new Promise<Blob>((resolve, reject) => {
            let settled = false;
            const finish = (value: Blob | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (value) resolve(value);
                else reject(new Error('The local chart image could not be encoded.'));
            };
            const timer = setTimeout(
                () => finish(null),
                Math.max(1, LOCAL_RASTER_DECODE_MS - (performance.now() - started)),
            );
            try {
                canvas.toBlob(finish, 'image/png');
            } catch (error) {
                settled = true;
                clearTimeout(timer);
                reject(error);
            }
        });
        check();
        rasterRequire(
            blob.type === 'image/png' && blob.size > 0 && blob.size <= 5 * 1024 * 1024,
            'Encoded chart image exceeds 5 MiB.',
        );
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
    const url = URL.createObjectURL(blob);
    let released = false;
    const release = () => {
        if (!released) {
            released = true;
            URL.revokeObjectURL(url);
        }
    };
    try {
        check();
    } catch (error) {
        release();
        throw error;
    }
    const [west, south, east, north] = image.bounds;
    return {
        source: {
            type: 'image',
            url,
            coordinates: [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
            ],
        },
        bounds: image.bounds,
        name: admitted.chart.name,
        isCurrent: admitted.isCurrent,
        release,
        note: `Private local ${kind === 'kap' ? 'KAP' : 'GeoTIFF'} · ${image.sourceProjection}. Own/open declaration only. ${image.note} Display only; never used by routing or alarms.`,
    };
}
