/**
 * scanBarcode — one barcode from the camera, for Ship's Stores (131-B13).
 *
 * The Add item sheet's Scan and the Edit sheet's camera button both come
 * here, so a refused camera reads the same in both. In the iPhone app it is
 * the VisionKit scanner (dataScanner); in a browser, the rear camera into a
 * <video> the sheet shows, read by the browser's BarcodeDetector.
 *
 * It never throws. The result is the code, or no code and the words to show
 * in the sheet: none when the skipper put the scanner away.
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('scanBarcode');

/** The camera is switched off for Thalassa. */
export const SCAN_DENIED =
    "Thalassa isn't allowed to use the camera. Turn on Camera for Thalassa in the iPhone's Settings, or type the barcode in.";
/** No scanner here: a browser without BarcodeDetector, no camera, or the plugin failed. */
export const SCAN_UNAVAILABLE = "The barcode scanner isn't working on this device. Type the barcode in.";

export type BarcodeScan = { code: string } | { code: null; problem: string | null };

/** Put away, or nothing read: nothing to say. */
const PUT_AWAY: BarcodeScan = { code: null, problem: null };

/** The browser's camera: the sheet's <video>, and the signal that closes it. */
export interface WebCamera {
    video: HTMLVideoElement | null;
    signal: AbortSignal;
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorClass = new (options: { formats: string[] }) => Detector;

const WEB_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

/** Read one barcode. In a browser, `web` is the sheet's camera; without one there is no scanner there. */
export async function scanBarcode(web?: WebCamera): Promise<BarcodeScan> {
    if (Capacitor.isNativePlatform()) return scanNative();
    return web ? scanWeb(web) : { code: null, problem: SCAN_UNAVAILABLE };
}

async function scanNative(): Promise<BarcodeScan> {
    try {
        const { BarcodeScanner, BarcodeFormat } = await import('./dataScanner');
        let { camera } = await BarcodeScanner.checkPermissions();
        if (camera !== 'granted') camera = (await BarcodeScanner.requestPermissions()).camera;
        if (camera !== 'granted') return { code: null, problem: SCAN_DENIED };
        const { barcodes } = await BarcodeScanner.scan({
            formats: [
                BarcodeFormat.Ean13,
                BarcodeFormat.Ean8,
                BarcodeFormat.UpcA,
                BarcodeFormat.UpcE,
                BarcodeFormat.Code128,
                BarcodeFormat.Code39,
                BarcodeFormat.QrCode,
            ],
        });
        const code = barcodes[0]?.rawValue?.trim();
        return code ? { code } : PUT_AWAY;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/cancel/i.test(message)) return PUT_AWAY;
        log.warn(' scanner failed:', message);
        return { code: null, problem: SCAN_UNAVAILABLE };
    }
}

async function scanWeb({ video, signal }: WebCamera): Promise<BarcodeScan> {
    const Detector = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    if (!Detector || !video || !navigator.mediaDevices?.getUserMedia) return { code: null, problem: SCAN_UNAVAILABLE };
    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        });
    } catch (err) {
        const denied = err instanceof Error && /NotAllowed|Permission|Security/i.test(`${err.name} ${err.message}`);
        return { code: null, problem: denied ? SCAN_DENIED : SCAN_UNAVAILABLE };
    }
    try {
        if (signal.aborted) return PUT_AWAY;
        video.srcObject = stream;
        await video.play();
        const detector = new Detector({ formats: WEB_FORMATS });
        return await new Promise<BarcodeScan>((resolve) => {
            // Detector calls can overlap when a frame takes longer than the
            // half second: the first code read is the one taken, once.
            let done = false;
            const finish = (result: BarcodeScan) => {
                if (done) return;
                done = true;
                clearInterval(timer);
                resolve(result);
            };
            const timer = setInterval(async () => {
                try {
                    const code = (await detector.detect(video))[0]?.rawValue?.trim();
                    if (code && code.length > 3) finish({ code });
                } catch (e) {
                    log.warn(' frame failed:', e);
                }
            }, 500);
            signal.addEventListener('abort', () => finish(PUT_AWAY), { once: true });
            if (signal.aborted) finish(PUT_AWAY);
        });
    } catch (err) {
        log.warn(' camera failed:', err);
        return { code: null, problem: SCAN_UNAVAILABLE };
    } finally {
        // The camera light goes out however the scan ends.
        for (const track of stream.getTracks()) track.stop();
        video.srcObject = null;
    }
}
