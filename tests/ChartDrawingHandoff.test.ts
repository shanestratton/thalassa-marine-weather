import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const f = vi.hoisted(() => ({
    scope: { key: 'user:A', userId: 'A', generation: 1 },
    wait: null as Promise<void> | null,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (s: unknown) => s === f.scope,
}));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        writeFile: vi.fn(async () => {
            if (f.wait) await f.wait;
            return { uri: 'private-cache-uri' };
        }),
        deleteFile: vi.fn(async () => {}),
    },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn(async () => {}) } }));
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { handoffAnnotationFile } from '../services/chartAnnotations/handoff';
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', webcrypto);
    f.scope = { key: 'user:A', userId: 'A', generation: 1 };
    f.wait = null;
    vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
it('native export uses a bounded anonymous cache filename and cleans only its temporary file', async () => {
    await handoffAnnotationFile('private geometry', 'GeoJSON');
    expect(Filesystem.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
            directory: 'CACHE',
            encoding: 'utf8',
            path: expect.stringMatching(/^chart-annotations-[a-f0-9-]+\.geojson$/),
            data: 'private geometry',
        }),
    );
    expect(Share.share).toHaveBeenCalledWith({
        title: 'Private chart annotations',
        dialogTitle: 'Export chart annotations',
        url: 'private-cache-uri',
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(Filesystem.deleteFile).toHaveBeenCalledTimes(1);
});
it('late account change after native write prevents opening the platform share sheet', async () => {
    let release!: () => void;
    f.wait = new Promise((r) => (release = r));
    const pending = handoffAnnotationFile('private geometry', 'GPX');
    f.scope = { key: 'user:B', userId: 'B', generation: 2 };
    release();
    await expect(pending).rejects.toThrow('account changed');
    expect(Share.share).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(Filesystem.deleteFile).toHaveBeenCalledTimes(1);
});

it('a retired foreground/vessel action cannot open a late native share sheet', async () => {
    let current = true,
        release!: () => void;
    f.wait = new Promise((r) => (release = r));
    const pending = handoffAnnotationFile('private geometry', 'GeoJSON', f.scope, { isCurrent: () => current });
    current = false;
    release();
    await expect(pending).rejects.toThrow('cancelled');
    expect(Share.share).not.toHaveBeenCalled();
});
