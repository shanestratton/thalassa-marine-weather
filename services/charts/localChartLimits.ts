/** Whole-file SQLite is deliberately limited until a native range reader is available. */
export const LOCAL_CHART_FILE_BYTES = 32 * 1024 * 1024;
export const LOCAL_CHART_OPEN_BYTES = 48 * 1024 * 1024;
export const LOCAL_CHART_TILE_BYTES = 1024 * 1024;
export const LOCAL_CHART_CACHE_BYTES = 8 * 1024 * 1024;

/** A short encoded image must not request an unbounded native decode. Animation is not a chart tile. */
export function localChartRasterDimensions(bytes: Uint8Array, mime: string): [number, number] | null {
    if (bytes.byteLength > LOCAL_CHART_TILE_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0,
        height = 0;
    if (
        mime === 'image/png' &&
        bytes.length >= 33 &&
        view.getUint32(8, false) === 13 &&
        view.getUint32(12, false) === 0x49484452
    ) {
        width = view.getUint32(16, false);
        height = view.getUint32(20, false);
    } else if (mime === 'image/jpeg') {
        let at = 2,
            segments = 0;
        while (at + 4 <= bytes.length && segments++ < 256) {
            if (bytes[at++] !== 0xff) return null;
            while (at < bytes.length && bytes[at] === 0xff) at++;
            const marker = bytes[at++];
            if (marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) return null;
            const size = view.getUint16(at, false);
            if (size < 2 || at + size > bytes.length) return null;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (size < 8) return null;
                height = view.getUint16(at + 3, false);
                width = view.getUint16(at + 5, false);
                break;
            }
            at += size;
        }
    } else if (mime === 'image/webp' && bytes.length >= 30) {
        const chunk = view.getUint32(12, false);
        if (chunk === 0x56503858 && bytes[20] & 2) return null;
        if (chunk === 0x56503858) {
            width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
            height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
        } else if (chunk === 0x5650384c && bytes[20] === 0x2f) {
            width = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8));
            height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0xf) << 10));
        } else if (chunk === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
            width = view.getUint16(26, true) & 0x3fff;
            height = view.getUint16(28, true) & 0x3fff;
        }
    }
    return width > 0 && height > 0 && width <= 1024 && height <= 1024 ? [width, height] : null;
}

export function assertLocalChartName(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,159}\.mbtiles$/i.test(name) || name.includes('..')) {
        throw new Error('Choose a local MBTiles chart.');
    }
}

export function assertLocalChartSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 512 || size > LOCAL_CHART_FILE_BYTES) {
        throw new Error('This phone opens MBTiles charts up to 32 MiB. Use the Pi for larger charts.');
    }
}

/** The original stat, declared HTTP length and actual bytes must agree. No unbounded arrayBuffer fallback. */
export async function readLocalChartBytes(response: Response, expectedBytes: number): Promise<Uint8Array> {
    assertLocalChartSize(expectedBytes);
    if (!response.ok || response.status !== 200 || !response.body)
        throw new Error('The local chart could not be read.');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expectedBytes)) {
        void response.body.cancel().catch(() => undefined);
        throw new Error('The local chart changed while it was being opened.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            count += value.byteLength;
            if (count > expectedBytes || count > LOCAL_CHART_FILE_BYTES)
                throw new Error('The local chart exceeds its size limit.');
            chunks.push(value);
        }
        if (count !== expectedBytes) throw new Error('The local chart is incomplete.');
        const bytes = new Uint8Array(count);
        let at = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.byteLength;
        }
        const magic = 'SQLite format 3\0';
        if (!Array.from(magic).every((letter, index) => bytes[index] === letter.charCodeAt(0))) {
            throw new Error('This file is not a SQLite MBTiles chart.');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const sizeField = view.getUint16(16, false),
            pageSize = sizeField === 1 ? 65536 : sizeField;
        if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || count % pageSize !== 0) {
            throw new Error('The chart has an invalid SQLite page size.');
        }
        return bytes;
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}
