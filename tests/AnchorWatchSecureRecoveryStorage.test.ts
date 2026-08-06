import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => {
    const secure = new Map<string, string>();
    const preferences = new Map<string, string>();
    const events: string[] = [];
    const account = (slot: 'device' | 'scoped', identityKey?: string) =>
        slot === 'device' ? 'device' : `scoped:${identityKey ?? ''}`;
    return {
        platform: 'ios',
        secure,
        preferences,
        events,
        account,
        discardNextWrite: false,
        failRemoveFor: null as string | null,
        failClearScoped: false,
        get: vi.fn(async ({ slot, identityKey }: { slot: 'device' | 'scoped'; identityKey?: string }) => {
            const key = account(slot, identityKey);
            events.push(`secure:get:${key}`);
            return { value: secure.get(key) ?? null };
        }),
        set: vi.fn(
            async ({
                slot,
                identityKey,
                value,
            }: {
                slot: 'device' | 'scoped';
                identityKey?: string;
                value: string;
            }) => {
                const key = account(slot, identityKey);
                events.push(`secure:set:${key}`);
                if (storageMocks.discardNextWrite) {
                    storageMocks.discardNextWrite = false;
                    return;
                }
                secure.set(key, value);
            },
        ),
        remove: vi.fn(async ({ slot, identityKey }: { slot: 'device' | 'scoped'; identityKey?: string }) => {
            const key = account(slot, identityKey);
            events.push(`secure:remove:${key}`);
            if (storageMocks.failRemoveFor === key) throw new Error(`remove failed for ${key}`);
            secure.delete(key);
        }),
        clearScoped: vi.fn(async () => {
            events.push('secure:clear-scoped');
            if (storageMocks.failClearScoped) throw new Error('scoped clear failed');
            for (const key of [...secure.keys()]) {
                if (key.startsWith('scoped:')) secure.delete(key);
            }
        }),
        preferencesGet: vi.fn(async ({ key }: { key: string }) => {
            events.push(`preferences:get:${key}`);
            return { value: preferences.get(key) ?? null };
        }),
        preferencesRemove: vi.fn(async ({ key }: { key: string }) => {
            events.push(`preferences:remove:${key}`);
            preferences.delete(key);
        }),
        preferencesKeys: vi.fn(async () => ({ keys: [...preferences.keys()] })),
    };
});

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => storageMocks.platform,
    },
    registerPlugin: () => ({
        get: storageMocks.get,
        set: storageMocks.set,
        remove: storageMocks.remove,
        clearScoped: storageMocks.clearScoped,
    }),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: storageMocks.preferencesGet,
        remove: storageMocks.preferencesRemove,
        keys: storageMocks.preferencesKeys,
    },
}));

import {
    ANCHOR_WATCH_DEVICE_RECOVERY_KEY,
    ANCHOR_WATCH_LEGACY_STATE_KEY,
    clearAnchorWatchRecovery,
    hasAnchorWatchRecovery,
    readAnchorWatchRecovery,
    writeAnchorWatchRecovery,
} from '../services/anchorWatchRecoveryStorage';
import { authScopedStorageKey, type AuthIdentityScope } from '../services/authIdentityScope';

const scope = (key: string, generation = 1): AuthIdentityScope => ({
    key,
    userId: key === 'anonymous' ? null : key.slice(5),
    generation,
});

describe('Anchor Watch secure recovery storage', () => {
    beforeEach(() => {
        storageMocks.platform = 'ios';
        storageMocks.secure.clear();
        storageMocks.preferences.clear();
        storageMocks.events.length = 0;
        storageMocks.discardNextWrite = false;
        storageMocks.failRemoveFor = null;
        storageMocks.failClearScoped = false;
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('writes device-authoritative and identity-scoped copies without an iOS plaintext shadow', async () => {
        const accountA = scope('user:account-a');
        const scopedLegacyKey = authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, accountA);
        localStorage.setItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY, 'legacy-device');
        localStorage.setItem(scopedLegacyKey, 'legacy-scoped');
        storageMocks.preferences.set(scopedLegacyKey, 'stale-preferences-copy');

        await writeAnchorWatchRecovery(accountA, 'current-watch');

        expect(storageMocks.secure.get('device')).toBe('current-watch');
        expect(storageMocks.secure.get('scoped:user:account-a')).toBe('current-watch');
        expect(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)).toBeNull();
        expect(localStorage.getItem(scopedLegacyKey)).toBeNull();
        expect(storageMocks.preferences.has(scopedLegacyKey)).toBe(false);
        expect(storageMocks.events.indexOf('secure:set:device')).toBeLessThan(
            storageMocks.events.indexOf(`preferences:remove:${ANCHOR_WATCH_DEVICE_RECOVERY_KEY}`),
        );
    });

    it('never deletes a legacy coordinate record before a secure write is read-verified', async () => {
        localStorage.setItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY, 'legacy-device');
        storageMocks.discardNextWrite = true;

        await expect(readAnchorWatchRecovery(scope('anonymous'))).rejects.toThrow('could not be verified');

        expect(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)).toBe('legacy-device');
        expect(storageMocks.preferencesRemove).not.toHaveBeenCalledWith({
            key: ANCHOR_WATCH_DEVICE_RECOVERY_KEY,
        });
    });

    it('migrates every attributable scoped legacy record and retires unowned plaintext', async () => {
        const accountA = scope('user:account-a');
        const accountB = scope('user:account-b');
        const accountAKey = authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, accountA);
        const accountBKey = authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, accountB);
        localStorage.setItem(accountAKey, 'watch-a');
        storageMocks.preferences.set(accountBKey, 'watch-b');
        localStorage.setItem(ANCHOR_WATCH_LEGACY_STATE_KEY, 'unowned-precise-position');

        await expect(readAnchorWatchRecovery(accountA)).resolves.toEqual({
            raw: 'watch-a',
            deviceRecovery: false,
        });

        expect(storageMocks.secure.get('scoped:user:account-a')).toBe('watch-a');
        expect(storageMocks.secure.get('scoped:user:account-b')).toBe('watch-b');
        expect(localStorage.getItem(accountAKey)).toBeNull();
        expect(storageMocks.preferences.has(accountBKey)).toBe(false);
        expect(localStorage.getItem(ANCHOR_WATCH_LEGACY_STATE_KEY)).toBeNull();
    });

    it('does not expose another identity scoped record when no device watch exists', async () => {
        storageMocks.secure.set('scoped:user:account-a', 'watch-a');

        await expect(readAnchorWatchRecovery(scope('user:account-b'))).resolves.toBeNull();
        await expect(readAnchorWatchRecovery(scope('user:account-a'))).resolves.toEqual({
            raw: 'watch-a',
            deviceRecovery: false,
        });
    });

    it('reports secure recovery to the deliberate account-exit safety interlock', async () => {
        storageMocks.secure.set('scoped:user:account-a', 'watch-a');

        await expect(hasAnchorWatchRecovery(scope('user:account-a'))).resolves.toBe(true);
        await expect(hasAnchorWatchRecovery(scope('user:account-b'))).resolves.toBe(false);
    });

    it('retains the device recovery authority when scoped clear cannot be confirmed', async () => {
        storageMocks.secure.set('device', 'active-watch');
        storageMocks.secure.set('scoped:user:account-a', 'active-watch');
        storageMocks.secure.set('scoped:user:account-b', 'stale-watch');
        storageMocks.failClearScoped = true;

        await expect(clearAnchorWatchRecovery(scope('user:account-a'))).rejects.toThrow('scoped clear failed');

        expect(storageMocks.secure.get('device')).toBe('active-watch');
        expect(storageMocks.secure.get('scoped:user:account-a')).toBe('active-watch');
        expect(storageMocks.secure.get('scoped:user:account-b')).toBe('stale-watch');
        expect(storageMocks.remove).not.toHaveBeenCalled();
    });

    it('retires every older identity scope before publishing a newly armed watch', async () => {
        storageMocks.secure.set('scoped:user:account-a', 'stale-watch-a');

        await writeAnchorWatchRecovery(scope('user:account-b'), 'watch-b');

        expect(storageMocks.secure.has('scoped:user:account-a')).toBe(false);
        expect(storageMocks.secure.get('scoped:user:account-b')).toBe('watch-b');
        expect(storageMocks.secure.get('device')).toBe('watch-b');
    });

    it('strict clear removes secure recovery plus every reviewed plaintext duplicate', async () => {
        const accountA = scope('user:account-a');
        const scopedLegacyKey = authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, accountA);
        storageMocks.secure.set('device', 'active-watch');
        storageMocks.secure.set('scoped:user:account-a', 'active-watch');
        storageMocks.secure.set('scoped:user:account-b', 'stale-watch');
        localStorage.setItem(scopedLegacyKey, 'stale-watch');

        await clearAnchorWatchRecovery(accountA);

        expect(storageMocks.secure.has('device')).toBe(false);
        expect(storageMocks.secure.has('scoped:user:account-a')).toBe(false);
        expect(storageMocks.secure.has('scoped:user:account-b')).toBe(false);
        expect(localStorage.getItem(scopedLegacyKey)).toBeNull();
    });

    it('can strictly clear corrupt legacy data that is not safe to migrate', async () => {
        localStorage.setItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY, 'x'.repeat(128 * 1024));
        localStorage.setItem(ANCHOR_WATCH_LEGACY_STATE_KEY, 'unowned-corrupt-location');

        await clearAnchorWatchRecovery(scope('user:account-a'));

        expect(storageMocks.set).not.toHaveBeenCalled();
        expect(localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)).toBeNull();
        expect(localStorage.getItem(ANCHOR_WATCH_LEGACY_STATE_KEY)).toBeNull();
    });

    it('keeps the browser implementation available without calling native storage', async () => {
        storageMocks.platform = 'web';
        const anonymous = scope('anonymous');

        await writeAnchorWatchRecovery(anonymous, 'browser-watch');
        await expect(readAnchorWatchRecovery(anonymous)).resolves.toEqual({
            raw: 'browser-watch',
            deviceRecovery: true,
        });
        await clearAnchorWatchRecovery(anonymous);

        expect(storageMocks.set).not.toHaveBeenCalled();
        expect(storageMocks.get).not.toHaveBeenCalled();
        expect(localStorage.length).toBe(0);
    });
});
