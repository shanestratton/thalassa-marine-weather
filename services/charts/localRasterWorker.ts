/// <reference lib="webworker" />
import { decodeKap } from './decodeKap';
import { decodeGeoTiff } from './decodeGeoTiff';
import { rasterDeadline } from './localRasterContract';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (
        !value ||
        typeof value !== 'object' ||
        !('id' in value) ||
        !('kind' in value) ||
        !('buffer' in value) ||
        !Number.isSafeInteger(value.id) ||
        !(value.buffer instanceof ArrayBuffer)
    )
        return;
    const id = value.id;
    try {
        const check = rasterDeadline();
        const bytes = new Uint8Array(value.buffer);
        const image =
            value.kind === 'kap'
                ? decodeKap(bytes, check)
                : value.kind === 'tif' || value.kind === 'tiff'
                  ? decodeGeoTiff(bytes, check)
                  : null;
        if (!image) throw new Error('Unsupported local raster chart kind.');
        check();
        worker.postMessage({ type: 'decoded', id, image }, [image.rgba.buffer]);
    } catch (error) {
        worker.postMessage({
            type: 'error',
            id,
            message: error instanceof Error ? error.message.slice(0, 400) : 'Raster chart decoder failed.',
        });
    }
};
worker.postMessage({ type: 'ready' });
