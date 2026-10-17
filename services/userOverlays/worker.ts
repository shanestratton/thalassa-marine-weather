import { normalizeOverlay, OVERLAY_INPUT_BYTES } from './model';
import { shapefileToGeoJSON } from './shapefile';

self.onmessage = (
    event: MessageEvent<{ bytes?: ArrayBuffer; value?: unknown; format: 'GeoJSON' | 'KML' | 'shapefile' }>,
) => {
    try {
        const { bytes, value, format } = event.data;
        if (bytes && bytes.byteLength > OVERLAY_INPUT_BYTES) throw Error('Overlay input exceeds 4 MiB.');
        const input =
            format === 'KML'
                ? value
                : format === 'shapefile'
                  ? shapefileToGeoJSON(new Uint8Array(bytes!))
                  : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        self.postMessage({ ok: true, preview: { ...normalizeOverlay(input), format } });
    } catch (error) {
        self.postMessage({
            ok: false,
            error: error instanceof Error && error.message.length <= 180 ? error.message : 'Overlay could not be read.',
        });
    }
};
