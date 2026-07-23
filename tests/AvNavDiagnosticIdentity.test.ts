import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeLogAsync } from '../services/AvNavService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

describe('AvNav durable diagnostics', () => {
    beforeEach(() => {
        vi.mocked(Preferences.get).mockReset().mockResolvedValue({ value: null });
        vi.mocked(Preferences.set).mockReset().mockResolvedValue(undefined);
        setAuthIdentityScope(`avnav-log-${crypto.randomUUID()}`);
    });

    it('uses the exact account namespace and removes credentials from the stored value', async () => {
        const scope = getAuthIdentityScope();

        await nativeLogAsync(
            'TILE https://data.linz.govt.nz/services;key=linz-secret/path?ticket=proxy-secret&sessionId=drm-secret',
        );

        expect(Preferences.set).toHaveBeenCalledOnce();
        const write = vi.mocked(Preferences.set).mock.calls[0]?.[0];
        expect(write?.key).toBe(authScopedStorageKey('SK_LOG', scope));
        expect(write?.value).not.toContain('linz-secret');
        expect(write?.value).not.toContain('proxy-secret');
        expect(write?.value).not.toContain('drm-secret');
        expect(write?.value).toContain('[REDACTED]');
    });

    it('does not read an account A diagnostic back through the bridge after A→B', async () => {
        let releaseWrite: (() => void) | undefined;
        vi.mocked(Preferences.set).mockReturnValue(
            new Promise<void>((resolve) => {
                releaseWrite = resolve;
            }),
        );

        const pending = nativeLogAsync('Account A chart probe');
        setAuthIdentityScope(`avnav-log-b-${crypto.randomUUID()}`);
        releaseWrite?.();
        await pending;

        expect(Preferences.get).not.toHaveBeenCalled();
    });
});
