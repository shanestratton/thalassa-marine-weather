/**
 * satIrPixels — reads one satellite frame's pixels on the phone so it can be
 * anchored before it is shown (satIrAnchor in satelliteImagery.ts), and hands
 * its bytes to Mapbox without a second download. Browser-only
 * (createImageBitmap, a canvas, FileReader); the tests mock this module.
 *
 * Verified in WebKit and Chromium against the PIL measurements: the tropical
 * 99.9th percentile matched within one count on all eight fixture frames,
 * although WebKit colour-manages the greyscale JPEG (~2% of pixels move a
 * count or two).
 */
import { SAT_IR_IMAGE_HEIGHT, SAT_IR_IMAGE_WIDTH, satIrTropicalRows } from './satelliteImagery';

/** Rows read back per getImageData: 3072 x 64 x 4 = 786 KB at a time. */
const STRIP_ROWS = 64;

/**
 * One frame at a time: each decode holds a full 3072x1288 bitmap (~15.8 MB)
 * until it is closed, and the rain scrubber can ask for several frames at
 * once. Serialised, the extra memory never exceeds one frame (the 2 GB
 * WebContent jetsam).
 */
let queue: Promise<unknown> = Promise.resolve();

async function readTropicalHistogram(blob: Blob): Promise<Uint32Array> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
        // The anchor's rows assume the image the request asked for.
        if (bitmap.width !== SAT_IR_IMAGE_WIDTH || bitmap.height !== SAT_IR_IMAGE_HEIGHT) {
            throw new Error(`unexpected frame size ${bitmap.width}x${bitmap.height}`);
        }
        const { first, count } = satIrTropicalRows(bitmap.height);
        const width = bitmap.width;
        canvas.width = width;
        canvas.height = STRIP_ROWS;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no 2d canvas');
        const hist = new Uint32Array(256);
        for (let y = first; y < first + count; y += STRIP_ROWS) {
            const rows = Math.min(STRIP_ROWS, first + count - y);
            ctx.clearRect(0, 0, width, STRIP_ROWS);
            ctx.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
            const px = ctx.getImageData(0, 0, width, rows).data;
            // Greyscale: the red channel is the grey count.
            for (let i = 0; i < px.length; i += 4) hist[px[i]]++;
        }
        return hist;
    } finally {
        bitmap.close();
        canvas.width = 0;
        canvas.height = 0;
    }
}

/** The tropical band's 256-bin grey histogram of one frame's JPEG. */
export function satIrTropicalHistogram(blob: Blob): Promise<Uint32Array> {
    const run = queue.then(() => readTropicalHistogram(blob));
    queue = run.catch(() => undefined);
    return run;
}

/**
 * The frame's bytes as a data: URL for updateImage. Mapbox loads an image
 * source with fetch(), so the URL must pass connect-src; data: always has.
 * (blob: is allowed too since W1-FX, for offline MBTiles tiles; switching the
 * frames to blob: URLs is possible but not needed.) ~0.5 MB a frame, kept
 * while the frame is listed.
 */
export function satIrDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
            typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('frame not readable'));
        reader.onerror = () => reject(reader.error ?? new Error('frame not readable'));
        reader.readAsDataURL(blob);
    });
}
