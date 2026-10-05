/**
 * Sighting photos leave the phone with no metadata: no EXIF, no GPS, no XMP,
 * no camera, no capture time. A photo's embedded position is exact and live,
 * which is everything the three-hour public delay and the grid exist to hide.
 *
 * Every photo is re-drawn through a canvas (decoded with the EXIF orientation
 * applied, so nothing needs the tag afterwards) and re-encoded as a fresh
 * JPEG of at most 1600 px on the long edge. The encoder may add its own
 * segments (iOS ImageIO writes an EXIF block with the pixel size and colour
 * space), so the bytes are then REWRITTEN without any metadata segment —
 * APP1 (EXIF, XMP), APP3 to APP13 (APP13 = Photoshop / IPTC), APP15 and
 * comments — keeping only what decoding needs (JFIF APP0, the ICC colour
 * profile in APP2, Adobe APP14, tables, frame and scan). Then they are
 * CHECKED again. Any failure THROWS. It never falls back to the original file
 * (DiaryService._compressImage resolves `blob || file`, which would upload
 * the camera's EXIF; this deliberately does not copy it).
 */

export const PHOTO_MAX_EDGE_PX = 1600;
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const QUALITIES = [0.82, 0.6] as const;
const FALLBACK_EDGE_PX = 1200;

export class PhotoStripError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PhotoStripError';
    }
}

/** APP1, APP3-APP13, APP15 and COM: segments that can carry a position, a time or an identity. */
export function isMetadataMarker(marker: number): boolean {
    return marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
}

interface Segment {
    marker: number;
    /** Offset of the 0xFF that starts it. */
    start: number;
    /** Offset just past it. */
    end: number;
}

/**
 * Walk the marker segments from SOI to SOS. Returns them and the offset of
 * the SOS marker (where the entropy-coded image starts). Throws on anything
 * that is not a well-formed JPEG head: nothing is uploaded that cannot be read.
 */
function headerSegments(bytes: Uint8Array): { segments: Segment[]; scanAt: number } {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new PhotoStripError('Not a JPEG');
    }
    const segments: Segment[] = [];
    let off = 2;
    while (off + 1 < bytes.length) {
        if (bytes[off] !== 0xff) throw new PhotoStripError('Malformed JPEG segment');
        // Fill bytes (0xFF 0xFF ...) may pad before a marker.
        let at = off;
        while (bytes[at + 1] === 0xff && at + 2 < bytes.length) at += 1;
        const marker = bytes[at + 1];
        if (marker === 0xda) return { segments, scanAt: at };
        if (marker === 0xd9) throw new PhotoStripError('JPEG has no image data');
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            segments.push({ marker, start: off, end: at + 2 });
            off = at + 2;
            continue;
        }
        if (at + 3 >= bytes.length) throw new PhotoStripError('Truncated JPEG');
        const length = (bytes[at + 2] << 8) | bytes[at + 3];
        if (length < 2 || at + 2 + length > bytes.length) throw new PhotoStripError('Malformed JPEG segment length');
        segments.push({ marker, start: off, end: at + 2 + length });
        off = at + 2 + length;
    }
    throw new PhotoStripError('Truncated JPEG');
}

/** Does this JPEG's header carry a metadata segment? Throws if it is not a readable JPEG. */
export function jpegHasMetadata(bytes: Uint8Array): boolean {
    return headerSegments(bytes).segments.some((segment) => isMetadataMarker(segment.marker));
}

/** The same JPEG with every metadata segment removed; the image data is copied untouched. */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const { segments, scanAt } = headerSegments(bytes);
    const kept = segments.filter((segment) => !isMetadataMarker(segment.marker));
    const size = 2 + kept.reduce((sum, s) => sum + (s.end - s.start), 0) + (bytes.length - scanAt);
    const out = new Uint8Array(size);
    out[0] = 0xff;
    out[1] = 0xd8;
    let at = 2;
    for (const segment of kept) {
        out.set(bytes.subarray(segment.start, segment.end), at);
        at += segment.end - segment.start;
    }
    out.set(bytes.subarray(scanAt), at);
    return out;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
    if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
    return new Uint8Array(
        await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error ?? new Error('read failed'));
            reader.readAsArrayBuffer(blob);
        }),
    );
}

interface Drawable {
    width: number;
    height: number;
    source: CanvasImageSource;
    close(): void;
}

/** Decode with the EXIF orientation applied, so the pixels are upright before the tags are dropped. */
async function decode(file: Blob): Promise<Drawable> {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
        } catch {
            // fall through to <img>, which applies EXIF orientation in modern WebKit
        }
    }
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new PhotoStripError('That photo could not be read'));
            el.src = url;
        });
        return {
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            source: img,
            close: () => undefined,
        };
    } finally {
        URL.revokeObjectURL(url);
    }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new PhotoStripError('The photo could not be re-encoded'))),
            'image/jpeg',
            quality,
        );
    });
}

function draw(image: Drawable, maxEdge: number): HTMLCanvasElement {
    if (!image.width || !image.height) throw new PhotoStripError('That photo has no size');
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoStripError('Canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    return canvas;
}

/**
 * A clean JPEG of the photo: re-drawn, re-encoded, at most PHOTO_MAX_BYTES,
 * and verified free of metadata. Throws PhotoStripError otherwise; the
 * caller shows "That photo couldn't be added" and keeps the sighting.
 */
export async function stripAndCompressPhoto(file: Blob): Promise<Blob> {
    const image = await decode(file);
    try {
        for (const edge of [PHOTO_MAX_EDGE_PX, FALLBACK_EDGE_PX]) {
            const canvas = draw(image, edge);
            for (const quality of QUALITIES) {
                const clean = stripJpegMetadata(await bytesOf(await encode(canvas, quality)));
                if (clean.length > PHOTO_MAX_BYTES) continue;
                if (jpegHasMetadata(clean)) {
                    throw new PhotoStripError('The re-encoded photo still carries metadata');
                }
                return new Blob([clean], { type: 'image/jpeg' });
            }
        }
        throw new PhotoStripError('That photo is too large even after compression');
    } finally {
        image.close();
    }
}
