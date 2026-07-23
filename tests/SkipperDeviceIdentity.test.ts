import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { getDeviceId, readRememberedHeld, rememberHeld } from '../services/skipperDevice';

describe('skipper device identity', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('uses a stable non-constant install identifier', () => {
        const first = getDeviceId();
        const second = getDeviceId();

        expect(first).toBe(second);
        expect(first).toMatch(/^dev-/);
        expect(first).not.toBe('dev-ephemeral');
        expect(localStorage.getItem('thalassa_device_id')).toBe(first);
    });

    it('keeps the previous-claim memo separate for each account', () => {
        const accountA = getAuthIdentityScope();
        rememberHeld(true);
        expect(readRememberedHeld()).toBe(true);

        setAuthIdentityScope('account-b');
        expect(readRememberedHeld()).toBe(false);
        rememberHeld(false);

        expect(localStorage.getItem(authScopedStorageKey('thalassa_skipper_held', accountA))).toBe('1');
        setAuthIdentityScope('account-a');
        expect(readRememberedHeld()).toBe(true);
    });

    it('keeps one random per-session identifier when storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('private mode');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('private mode');
        });

        const first = getDeviceId();
        const second = getDeviceId();

        expect(first).toBe(second);
        expect(first).toMatch(/^dev-/);
        expect(first).not.toBe('dev-ephemeral');
    });
});
