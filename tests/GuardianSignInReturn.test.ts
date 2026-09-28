/**
 * Settings' Back honours a page's return key (the Radio console). Guardian's
 * sign-in detour to Settings is retired: its signed-out card opens the sign-in
 * sheet in place (UX scorecard run 10; see tests/GuardianPage.test.tsx).
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

describe('Settings return key', () => {
    afterEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
    });

    it('still honours the Radio console return key', () => {
        const setPage = vi.fn();
        localStorage.setItem(authScopedStorageKey('thalassa_settings_return_to'), 'radio');
        const settings = VIEW_REGISTRY.settings.getProps!(ctx(setPage)) as { onBack: () => void };
        settings.onBack();
        expect(setPage).toHaveBeenLastCalledWith('radio');
    });

    it('gives Guardian no sign-in detour to Settings', () => {
        const setPage = vi.fn();
        const guardian = VIEW_REGISTRY.guardian.getProps!(ctx(setPage));
        expect(Object.keys(guardian)).toEqual(['onBack']);
    });
});
