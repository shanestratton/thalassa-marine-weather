import { LOCAL_CHART_FILE_BYTES } from './localChartLimits';
export const localChartBase64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
/** Chunked Filesystem binary-string representation; no full binary-string copy. */
export function encodeLocalChartBase64(bytes: Uint8Array, check: () => void): string {
    if (bytes.length > LOCAL_CHART_FILE_BYTES) throw new Error('The selected chart is too large.');
    const chunks: string[] = [];
    for (let at = 0; at < bytes.length; at += 49152) {
        check();
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(at, at + 49152))));
    }
    check();
    return chunks.join('');
}
export function decodeLocalChartBase64(value: string, size: number, check: () => void): Uint8Array {
    const padding = (3 - (size % 3)) % 3;
    if (
        !Number.isSafeInteger(size) ||
        size < 8 ||
        size > LOCAL_CHART_FILE_BYTES ||
        value.length !== localChartBase64Length(size) ||
        /[^A-Za-z0-9+/=]/.test(value) ||
        value.indexOf('=') !== (padding ? value.length - padding : -1)
    )
        throw new Error('Saved browser chart encoding is invalid.');
    const output = new Uint8Array(size);
    let offset = 0;
    for (let at = 0; at < value.length; at += 65536) {
        check();
        const chunk = atob(value.slice(at, at + 65536));
        if (offset + chunk.length > size) throw new Error('Saved browser chart exceeds its original size.');
        for (let n = 0; n < chunk.length; n++) output[offset++] = chunk.charCodeAt(n);
    }
    check();
    if (offset !== size) throw new Error('Saved browser chart is incomplete.');
    return output;
}
