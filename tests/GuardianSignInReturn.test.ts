/**
 * Guardian's signed-out "Sign in in Settings" opens Settings on Account &
 * Cloud and Settings' Back returns to Guardian — even though signing in flips
 * the auth scope the return key was written under (UX scorecard run 6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VIEW_REGISTRY, type ViewContext } from '../viewRegistry';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const ctx = (setPage: (view: string) => void): ViewContext => ({
    setPage,
    previousView: 'vessel',
    setIsUpgradeOpen: vi.fn(),
    settings: {},
    updateSettings: vi.fn(),
    handleFavoriteSelect: vi.fn(),
    weatherAlerts: [],
});

describe('Guardian sign-in detour', () => {
    afterEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
    });

    it('opens Account & Cloud and comes back to Guardian after signing in', () => {
        setAuthIdentityScope(null);
        const setPage = vi.fn();

        const guardian = VIEW_REGISTRY.guardian.getProps!(ctx(setPage)) as { onSignIn: () => void };
        guardian.onSignIn();
        expect(setPage).toHaveBeenLastCalledWith('settings');
        expect(localStorage.getItem(authScopedStorageKey('thalassa_settings_initial_tab'))).toBe('account');

        // Signing in happens inside Settings, before its Back is pressed.
        setAuthIdentityScope('sailor-1');
        const settings = VIEW_REGISTRY.settings.getProps!(ctx(setPage)) as { onBack: () => void };
        settings.onBack();
        expect(setPage).toHaveBeenLastCalledWith('guardian');

        // The detour is spent: the signed-out key is cleared and the next
        // ordinary visit to Settings goes back to the Vessel hub.
        setAuthIdentityScope(null);
        expect(localStorage.getItem(authScopedStorageKey('thalassa_settings_return_to'))).toBeNull();
        const again = VIEW_REGISTRY.settings.getProps!(ctx(setPage)) as { onBack: () => void };
        again.onBack();
        expect(setPage).toHaveBeenLastCalledWith('vessel');
    });

    it('still honours the Radio console return key', () => {
        const setPage = vi.fn();
        localStorage.setItem(authScopedStorageKey('thalassa_settings_return_to'), 'radio');
        const settings = VIEW_REGISTRY.settings.getProps!(ctx(setPage)) as { onBack: () => void };
        settings.onBack();
        expect(setPage).toHaveBeenLastCalledWith('radio');
    });
});
