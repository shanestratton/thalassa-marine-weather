import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { OVERLAY_INPUT_BYTES, normalizeOverlay, type OverlayPreview } from './model';
import { kmlToGeoJSON } from './kml';

let processing = false;
/** One owned worker, bounded read, five-second parse, no remote resources or fallback on main-thread inflation. */
export async function previewUserOverlay(file: File, signal?: AbortSignal): Promise<OverlayPreview> {
    if (processing) throw Error('Another overlay is still being read.');
    if (file.size < 2 || file.size > OVERLAY_INPUT_BYTES) throw Error('Choose an overlay up to 4 MiB.');
    const format: OverlayPreview['format'] | null = /\.(?:geojson|json)$/i.test(file.name)
        ? 'GeoJSON'
        : /\.kml$/i.test(file.name)
          ? 'KML'
          : /\.zip$/i.test(file.name)
            ? 'shapefile'
            : null;
    if (!format) throw Error('Choose GeoJSON, KML, or one zipped WGS84 shapefile.');
    const scope = getAuthIdentityScope();
    const check = () => {
        if (signal?.aborted || !isAuthIdentityScopeCurrent(scope)) throw Error('Overlay import cancelled.');
    };
    processing = true;
    let worker: Worker | undefined;
    try {
        check();
        const bytes = await file.arrayBuffer();
        check();
        if (bytes.byteLength !== file.size) throw Error('The selected file changed.');
        const value =
            format === 'KML' ? kmlToGeoJSON(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : undefined;
        worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        return await new Promise<OverlayPreview>((resolve, reject) => {
            const stop = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', aborted);
                worker?.terminate();
            };
            const aborted = () => {
                stop();
                reject(Error('Overlay import cancelled.'));
            };
            const timer = setTimeout(() => {
                stop();
                reject(Error('Overlay parsing exceeded five seconds. Use a smaller file.'));
            }, 5000);
            signal?.addEventListener('abort', aborted, { once: true });
            worker!.onerror = () => {
                stop();
                reject(Error('The local overlay worker is unavailable.'));
            };
            worker!.onmessage = (event) => {
                stop();
                try {
                    check();
                    const message = event.data;
                    if (!message?.ok)
                        throw Error(
                            typeof message?.error === 'string'
                                ? message.error.slice(0, 180)
                                : 'Overlay could not be read.',
                        );
                    // An owned worker still crosses a shape boundary. Recheck its bounded normalized result.
                    const preview = { ...normalizeOverlay(message.preview?.data), format };
                    resolve(preview);
                } catch (error) {
                    reject(error);
                }
            };
            try {
                check();
                if (format === 'KML') worker!.postMessage({ format, value });
                else worker!.postMessage({ format, bytes }, [bytes]);
            } catch (error) {
                stop();
                reject(error);
            }
        });
    } finally {
        worker?.terminate();
        processing = false;
    }
}
