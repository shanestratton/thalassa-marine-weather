import { describe, expect, it, vi } from 'vitest';
import type { ReadFileResult, StatResult } from '@capacitor/filesystem';
import { Directory } from '@capacitor/filesystem/dist/esm/definitions';
import {
    FICTIONAL_CHART_MAX_BYTES,
    FICTIONAL_CHART_PATH,
    fictionalNativeStat,
} from '../e2e/fixtures/mbtiles-native-stat';

const options = { path: FICTIONAL_CHART_PATH, directory: Directory.Cache };
const original = Uint8Array.from({ length: 12_288 }, (_, index) => index % 256);
const encoded = Buffer.from(original).toString('base64');

function fixture() {
    const metadata: StatResult = {
        name: 'fictional-ocean-test.mbtiles',
        type: 'file',
        size: encoded.length,
        ctime: 17,
        mtime: 23,
        uri: `/CACHE/${FICTIONAL_CHART_PATH}`,
    };
    const real = {
        stat: vi.fn(async (): Promise<StatResult> => metadata),
        readFile: vi.fn(async (): Promise<ReadFileResult> => ({ data: encoded })),
    };
    return { metadata, real, stat: fictionalNativeStat(real, () => original) };
}

describe('the sole fictional chart native stat boundary', () => {
    it('keeps real encoded metadata separate and reports raw size only after exact byte readback', async () => {
        const { real, metadata, stat } = fixture();
        expect(metadata.size).toBe(16_384);
        expect(await stat(options)).toEqual({ ...metadata, size: 12_288 });
        expect(metadata.size).toBe(16_384);
        expect(real.stat).toHaveBeenCalledExactlyOnceWith(options);
        expect(real.readFile).toHaveBeenCalledExactlyOnceWith(options);
    });

    it.each([
        { ...options, path: 'chart_downloads/another.mbtiles' },
        { ...options, path: `/${FICTIONAL_CHART_PATH}` },
        { ...options, directory: Directory.Data },
        { path: FICTIONAL_CHART_PATH },
    ])('delegates unrelated stat unchanged: %j', async (other) => {
        const { real, metadata, stat } = fixture();
        expect(await stat(other)).toBe(metadata);
        expect(real.stat).toHaveBeenCalledExactlyOnceWith(other);
        expect(real.readFile).not.toHaveBeenCalled();
    });

    it('refuses one changed byte even when raw and encoded lengths still match', async () => {
        const { real, stat } = fixture();
        const changed = original.slice();
        changed[changed.length - 1] ^= 1;
        real.readFile.mockResolvedValue({ data: Buffer.from(changed).toString('base64') });
        await expect(stat(options)).rejects.toThrow('bytes changed');
    });

    it('refuses a changed real encoded size', async () => {
        const { real, metadata, stat } = fixture();
        real.stat.mockResolvedValue({ ...metadata, size: metadata.size - 1 });
        await expect(stat(options)).rejects.toThrow('metadata changed');
    });

    it('refuses a directory before reading content', async () => {
        const { real, metadata, stat } = fixture();
        real.stat.mockResolvedValue({ ...metadata, type: 'directory' });
        await expect(stat(options)).rejects.toThrow('no verified file');
        expect(real.readFile).not.toHaveBeenCalled();
    });

    it.each([undefined, new Uint8Array(0), new Uint8Array(FICTIONAL_CHART_MAX_BYTES + 1)])(
        'refuses absent or unbounded expected bytes before content read',
        async (bytes) => {
            const { real } = fixture();
            await expect(fictionalNativeStat(real, () => bytes)(options)).rejects.toThrow('no verified file');
            expect(real.readFile).not.toHaveBeenCalled();
        },
    );

    it('preserves a real missing-file refusal', async () => {
        const { real, stat } = fixture();
        const failure = new Error('Entry does not exist.');
        real.stat.mockRejectedValue(failure);
        await expect(stat(options)).rejects.toBe(failure);
        expect(real.readFile).not.toHaveBeenCalled();
    });

    it('refuses Blob storage and malformed base64 rather than pretending raw metadata', async () => {
        const { real, stat } = fixture();
        real.readFile.mockResolvedValue({ data: new Blob(['fictional']) });
        await expect(stat(options)).rejects.toThrow('metadata changed');
        real.readFile.mockResolvedValue({ data: '!'.repeat(encoded.length) });
        await expect(stat(options)).rejects.toThrow();
    });
});
