import type { FilesystemPlugin } from '@capacitor/filesystem';
import { Directory } from '@capacitor/filesystem/dist/esm/definitions';

export const FICTIONAL_CHART_PATH = 'chart_downloads/fictional-ocean-test.mbtiles';
export const FICTIONAL_CHART_MAX_BYTES = 256 * 1024;

/**
 * This fixture models the native raw-byte stat contract for one fictional file.
 * The actual browser adapter stores base64 strings and reports their encoded
 * length; it cannot stand in for native stat without this disclosed boundary.
 * Every unrelated stat is delegated unchanged. No production reader is patched.
 */
export function fictionalNativeStat(
    real: Pick<FilesystemPlugin, 'stat' | 'readFile'>,
    originalBytes: () => Uint8Array | undefined,
): FilesystemPlugin['stat'] {
    return async (options) => {
        const actual = await real.stat(options);
        if (options.directory !== Directory.Cache || options.path !== FICTIONAL_CHART_PATH) return actual;
        const expected = originalBytes();
        if (!expected?.length || expected.length > FICTIONAL_CHART_MAX_BYTES || actual.type !== 'file')
            throw new Error('Fictional native stat has no verified file.');
        const read = await real.readFile(options);
        const encodedBytes = 4 * Math.ceil(expected.length / 3);
        if (typeof read.data !== 'string' || read.data.length !== encodedBytes || actual.size !== encodedBytes)
            throw new Error('Fictional browser storage metadata changed.');
        const decoded = atob(read.data);
        if (decoded.length !== expected.length || !expected.every((byte, index) => decoded.charCodeAt(index) === byte))
            throw new Error('Fictional native stat bytes changed.');
        return { ...actual, size: decoded.length };
    };
}
