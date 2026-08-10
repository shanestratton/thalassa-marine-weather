/**
 * sniffImageMime — magic-byte identification for fetched tile/image bodies.
 *
 * WHY: the 2026-08-04 crash hunt found several lanes handing unvalidated
 * bytes to createImageBitmap / the GL image decoder — a 200-status error
 * page, a truncated WebP, or a corrupt MBTiles row goes straight into
 * ImageIO, and on beta-WebKit a decoder fault is a renderer kill
 * ("makeImagePlus: 'WEBP' initImage failed err=-50"), not a blank tile.
 * Every decode of network- or disk-sourced bytes should gate on this first
 * and treat null as a tile miss.
 *
 * `totalLength` lets callers sniff a small prefix slice while still sanity-
 * checking WebP's declared RIFF size against the full body length.
 */
export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function sniffImageMime(bytes: Uint8Array, totalLength?: number): SniffedImageMime | null {
    const total = totalLength ?? bytes.length;
    if (
        bytes.length > 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        bytes.length > 11 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        // A truncated WebP passes a magic-only sniff but faults the decoder:
        // require the declared RIFF chunk size to fit inside the actual body.
        const declared = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
        return declared + 8 <= total ? 'image/webp' : null;
    }
    if (
        bytes.length > 5 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
    ) {
        return 'image/gif';
    }
    return null;
}

/** True when the bytes look like a gzip stream (vector PBF tiles in MBTiles). */
export function looksGzipped(bytes: Uint8Array): boolean {
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
