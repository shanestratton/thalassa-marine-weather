export interface Pixels {
    width: number;
    height: number;
    data: Uint8Array;
}
export interface JpegCodec {
    decode(
        bytes: Uint8Array,
        options: { useTArray: true; tolerantDecoding: false; maxResolutionInMP: number; maxMemoryUsageInMB: number },
    ): Pixels;
    encode(pixels: Pixels, quality: number): { data: Uint8Array };
}
/** Reject dimensions before allocating decoder output; never preserve EXIF/comments. */
export function jpegSize(b: Uint8Array, maxDimension = 1600, maxPixels = 1_920_000): { width: number; height: number } {
    if (b.length < 4 || b[0] !== 255 || b[1] !== 216) throw new Error('JPEG required');
    let i = 2;
    while (i < b.length) {
        if (b[i++] !== 255) throw new Error('Malformed JPEG');
        while (b[i] === 255) i++;
        const marker = b[i++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 2 > b.length) break;
        const len = (b[i] << 8) | b[i + 1];
        if (len < 2 || i + len > b.length) throw new Error('Malformed JPEG segment');
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            if (len < 8) throw new Error('Malformed JPEG frame');
            const height = (b[i + 3] << 8) | b[i + 4], width = (b[i + 5] << 8) | b[i + 6];
            if (
                width < 1 || height < 1 || width > maxDimension || height > maxDimension || width * height > maxPixels
            ) throw new Error('JPEG dimensions exceed the processing limit');
            return { width, height };
        }
        i += len;
    }
    throw new Error('Unsupported JPEG frame');
}
export function sanitizeReviewJpeg(bytes: Uint8Array, codec: JpegCodec): Uint8Array {
    if (bytes.byteLength > 2_097_152) throw new Error('JPEG upload is limited to 2 MB');
    const size = jpegSize(bytes);
    const pixels = codec.decode(bytes, {
        useTArray: true,
        tolerantDecoding: false,
        maxResolutionInMP: 2,
        maxMemoryUsageInMB: 64,
    });
    if (
        pixels.width !== size.width || pixels.height !== size.height ||
        pixels.data.length !== size.width * size.height * 4
    ) throw new Error('JPEG dimensions changed');
    // Pass a fresh object containing pixels ONLY: jpeg-js supports exifBuffer/comments on decoded objects.
    const encoded = codec.encode({ width: size.width, height: size.height, data: pixels.data }, 78).data;
    if (encoded.length < 4 || encoded.length > 1_048_576) {
        throw new Error('Processed photo exceeds 1 MB; choose a smaller image');
    }
    jpegSize(encoded);
    return encoded;
}
export async function readPhotoBody(req: Request): Promise<Uint8Array> {
    const n = Number(req.headers.get('content-length'));
    if (n > 2_097_152) throw new Error('Photo too large');
    if (!req.body) throw new Error('Photo required');
    const reader = req.body.getReader();
    const output = new Uint8Array(2_097_152);
    let length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Upload deadline exceeded')), 5000);
    });
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), deadline]);
            if (done) break;
            length += value.byteLength;
            if (length > 2_097_152) throw new Error('Photo too large');
            output.set(value, length - value.byteLength);
        }
    } catch (e) {
        void reader.cancel().catch(() => {});
        throw e;
    } finally {
        reader.releaseLock();
        clearTimeout(timer);
    }
    return output.slice(0, length);
}
