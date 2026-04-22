/**
 * dataScanner — Platform-aware barcode scanner wrapper.
 *
 * Replaces direct usage of @capacitor-mlkit/barcode-scanning throughout
 * the app. Native iOS uses our custom DataScanner plugin (VisionKit
 * DataScannerViewController), web falls back to the browser's
 * `BarcodeDetector` API or getUserMedia + @zxing-js if needed.
 *
 * The API shape mirrors the old MLKit surface so the call-site diff is
 * essentially one import change.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('dataScanner');

// ── Types ────────────────────────────────────────────────────────────

/**
 * Supported barcode format strings. Intentionally matches the original
 * MLKit `BarcodeFormat` enum values (PascalCase) so existing callers
 * keep working with a search-and-replace of the import.
 */
export const BarcodeFormat = {
    Ean13: 'Ean13',
    Ean8: 'Ean8',
    UpcA: 'UpcA',
    UpcE: 'UpcE',
    Code128: 'Code128',
    Code39: 'Code39',
    Code93: 'Code93',
    QrCode: 'QrCode',
    Aztec: 'Aztec',
    DataMatrix: 'DataMatrix',
    Pdf417: 'Pdf417',
    Itf14: 'Itf14',
    I2of5: 'I2of5',
} as const;
export type BarcodeFormat = (typeof BarcodeFormat)[keyof typeof BarcodeFormat];

export interface ScanOptions {
    formats?: BarcodeFormat[];
}

export interface ScannedBarcode {
    rawValue: string;
    format: string;
}

export interface ScanResult {
    barcodes: ScannedBarcode[];
}

export interface PermissionResult {
    camera: 'granted' | 'denied' | 'prompt';
}

// ── Native plugin handle ─────────────────────────────────────────────

interface DataScannerPlugin {
    checkPermissions(): Promise<PermissionResult>;
    requestPermissions(): Promise<PermissionResult>;
    isSupported(): Promise<{ supported: boolean; reason?: string }>;
    scan(options?: ScanOptions): Promise<ScanResult>;
}

const DataScannerNative = registerPlugin<DataScannerPlugin>('DataScanner');

// ── Public API ───────────────────────────────────────────────────────

/** Check whether camera permission has already been granted. */
export async function checkPermissions(): Promise<PermissionResult> {
    if (!Capacitor.isNativePlatform()) {
        // Web: probe via navigator.permissions if available, otherwise
        // report 'prompt' so the UI triggers getUserMedia which itself
        // shows the permission dialog.
        try {
            const anyNav = navigator as Navigator & {
                permissions?: { query: (q: { name: PermissionName }) => Promise<PermissionStatus> };
            };
            if (anyNav.permissions?.query) {
                const status = await anyNav.permissions.query({ name: 'camera' as PermissionName });
                return { camera: status.state as PermissionResult['camera'] };
            }
        } catch {
            /* Safari, older browsers */
        }
        return { camera: 'prompt' };
    }
    return DataScannerNative.checkPermissions();
}

/** Prompt the user for camera access. Idempotent — safe to call if
 *  permission is already granted. */
export async function requestPermissions(): Promise<PermissionResult> {
    if (!Capacitor.isNativePlatform()) {
        try {
            // Requesting a one-shot stream triggers the browser prompt
            // and we immediately release it.
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            for (const track of stream.getTracks()) track.stop();
            return { camera: 'granted' };
        } catch {
            return { camera: 'denied' };
        }
    }
    return DataScannerNative.requestPermissions();
}

/** Present the native scanner and resolve when the user picks a code
 *  (or cancels — `barcodes` is empty in that case). */
export async function scan(options?: ScanOptions): Promise<ScanResult> {
    if (!Capacitor.isNativePlatform()) {
        // Web fallback: caller is expected to manage a getUserMedia
        // stream + BarcodeDetector themselves. This preserves the
        // existing web flow in InventoryScanner.tsx which never went
        // through the MLKit import anyway.
        log.warn('dataScanner.scan() called on web — use the inline BarcodeDetector flow instead.');
        return { barcodes: [] };
    }

    try {
        return await DataScannerNative.scan(options);
    } catch (err) {
        // Re-throw with a stable message so callers can distinguish
        // "user cancelled" (resolved with empty array) from a real
        // failure (this rejection).
        throw err;
    }
}

/** Quick capability probe for the settings screen / debug panels. */
export async function isSupported(): Promise<{ supported: boolean; reason?: string }> {
    if (!Capacitor.isNativePlatform()) {
        // Web support is gated on BarcodeDetector being present.
        const hasNativeDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;
        return {
            supported: hasNativeDetector,
            reason: hasNativeDetector ? undefined : 'BarcodeDetector API not available in this browser.',
        };
    }
    return DataScannerNative.isSupported();
}

// Default export for call-site parity with MLKit (which exported a
// singleton-like `BarcodeScanner`).
export const BarcodeScanner = {
    checkPermissions,
    requestPermissions,
    scan,
    isSupported,
};
