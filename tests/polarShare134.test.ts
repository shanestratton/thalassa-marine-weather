import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ native: true, write: vi.fn(), share: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => state.native } }));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: { writeFile: state.write },
    Directory: { Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: state.share } }));
import { sharePolar } from '../services/polarTools';
const polar = {
    windSpeeds: [6, 12],
    angles: [45, 90],
    matrix: [
        [3, 5],
        [4, 6],
    ],
};
beforeEach(() => {
    state.native = true;
    state.write.mockReset().mockResolvedValue({ uri: 'file:///cache/polar.csv' });
    state.share.mockReset().mockResolvedValue(undefined);
});
it('exports only the polar into a safe cache filename and presents the native file share sheet', async () => {
    await sharePolar(polar, 'csv', '../../Fictional yacht');
    expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({
            path: '-Fictional-yacht.csv',
            directory: 'CACHE',
            encoding: 'utf8',
            data: expect.stringContaining('TWA\\TWS,6,12'),
        }),
    );
    expect(state.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/polar.csv'] }));
});
it('share cancellation does not trigger a second export, and real share failures remain visible', async () => {
    state.share.mockRejectedValueOnce(new Error('User cancelled'));
    await expect(sharePolar(polar, 'pol', 'yacht')).resolves.toBeUndefined();
    expect(state.write).toHaveBeenCalledTimes(1);
    state.share.mockRejectedValueOnce(new Error('File unavailable'));
    await expect(sharePolar(polar, 'pol', 'yacht')).rejects.toThrow('File unavailable');
});
