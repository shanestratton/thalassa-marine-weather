/**
 * scanBarcode — one barcode from the camera, shared by the Stores Add sheet
 * and Edit sheet (131-B13).
 *
 * The two sheets each had their own copy of the scanner call, and both
 * swallowed a refused camera: the Add sheet set a message only the dead
 * full-screen camera showed, the Edit sheet logged it. Now one helper answers
 * with the code, or with the words the sheet shows (none when put away).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';

const scanner = vi.hoisted(() => ({
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    scan: vi.fn(),
}));

vi.mock('../services/native/dataScanner', () => ({
    BarcodeScanner: scanner,
    BarcodeFormat: {
        Ean13: 'Ean13',
        Ean8: 'Ean8',
        UpcA: 'UpcA',
        UpcE: 'UpcE',
        Code128: 'Code128',
        Code39: 'Code39',
        QrCode: 'QrCode',
    },
}));

import { SCAN_DENIED, SCAN_UNAVAILABLE, scanBarcode } from '../services/native/scanBarcode';

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    Reflect.deleteProperty(window, 'BarcodeDetector');
    Reflect.deleteProperty(navigator, 'mediaDevices');
    vi.restoreAllMocks();
});

describe('in the iPhone app', () => {
    beforeEach(() => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        scanner.checkPermissions.mockResolvedValue({ camera: 'granted' });
        scanner.scan.mockResolvedValue({ barcodes: [{ rawValue: ' 9300000000017 ', format: 'Ean13' }] });
    });

    it('reads the code, trimmed, asking for nothing it already has', async () => {
        await expect(scanBarcode()).resolves.toEqual({ code: '9300000000017' });
        expect(scanner.requestPermissions).not.toHaveBeenCalled();
        expect(scanner.scan).toHaveBeenCalledWith({
            formats: ['Ean13', 'Ean8', 'UpcA', 'UpcE', 'Code128', 'Code39', 'QrCode'],
        });
    });

    it('asks for the camera once, and reads when it is allowed', async () => {
        scanner.checkPermissions.mockResolvedValue({ camera: 'prompt' });
        scanner.requestPermissions.mockResolvedValue({ camera: 'granted' });
        await expect(scanBarcode()).resolves.toEqual({ code: '9300000000017' });
        expect(scanner.requestPermissions).toHaveBeenCalledTimes(1);
    });

    it('a refused camera says how to turn it on, and opens no scanner', async () => {
        scanner.checkPermissions.mockResolvedValue({ camera: 'denied' });
        scanner.requestPermissions.mockResolvedValue({ camera: 'denied' });
        await expect(scanBarcode()).resolves.toEqual({ code: null, problem: SCAN_DENIED });
        expect(scanner.scan).not.toHaveBeenCalled();
        expect(SCAN_DENIED).toMatch(/Settings/);
        expect(SCAN_DENIED).toMatch(/type the barcode in/);
    });

    it('put away, or nothing read: no code and nothing to say', async () => {
        scanner.scan.mockRejectedValueOnce(new Error('User cancelled the scan'));
        await expect(scanBarcode()).resolves.toEqual({ code: null, problem: null });
        scanner.scan.mockResolvedValueOnce({ barcodes: [] });
        await expect(scanBarcode()).resolves.toEqual({ code: null, problem: null });
    });

    it('a scanner that fails says the scanner is not working, never throws', async () => {
        scanner.scan.mockRejectedValueOnce(new Error('DataScannerViewController is not supported'));
        await expect(scanBarcode()).resolves.toEqual({ code: null, problem: SCAN_UNAVAILABLE });
    });
});

describe('in a browser', () => {
    const video = () => document.createElement('video');

    function camera(detect: () => Promise<{ rawValue: string }[]>, getUserMedia = vi.fn()) {
        const stopped = vi.fn();
        getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopped }] });
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
        Object.defineProperty(window, 'BarcodeDetector', {
            configurable: true,
            value: class {
                detect = detect;
            },
        });
        return { stopped, getUserMedia };
    }

    it('without a camera in the sheet there is no scanner: it says so', async () => {
        await expect(scanBarcode()).resolves.toEqual({ code: null, problem: SCAN_UNAVAILABLE });
    });

    it('without BarcodeDetector it says so, and never lights the camera', async () => {
        const getUserMedia = vi.fn();
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
        await expect(scanBarcode({ video: video(), signal: new AbortController().signal })).resolves.toEqual({
            code: null,
            problem: SCAN_UNAVAILABLE,
        });
        expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('a camera the browser refuses says how to allow it', async () => {
        const { getUserMedia } = camera(vi.fn());
        getUserMedia.mockRejectedValue(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
        await expect(scanBarcode({ video: video(), signal: new AbortController().signal })).resolves.toEqual({
            code: null,
            problem: SCAN_DENIED,
        });
    });

    it('reads the first code once, and puts the camera out', async () => {
        vi.useFakeTimers();
        try {
            const detect = vi.fn().mockResolvedValue([{ rawValue: '4000000000006' }]);
            const { stopped } = camera(detect);
            const result = scanBarcode({ video: video(), signal: new AbortController().signal });
            await vi.advanceTimersByTimeAsync(1_600);
            await expect(result).resolves.toEqual({ code: '4000000000006' });
            expect(stopped).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('closed before a code: put away, camera out', async () => {
        vi.useFakeTimers();
        try {
            const { stopped } = camera(vi.fn().mockResolvedValue([]));
            const stop = new AbortController();
            const result = scanBarcode({ video: video(), signal: stop.signal });
            await vi.advanceTimersByTimeAsync(1_100);
            stop.abort();
            await expect(result).resolves.toEqual({ code: null, problem: null });
            expect(stopped).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
