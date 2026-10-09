/**
 * The trial switch for moving the mark of a Pi-kept watch (126-07a, D6).
 *
 * Until Shane's smoke test passes aboard, Shore Watch's Move anchor chip for a
 * Pi watch is behind Settings → Preferences → Anchor watch → "Move the anchor
 * while the Pi keeps watch (trial)", off by default. Switches live in
 * Preferences (Shane 2026-09-09).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralTab } from '../components/settings/GeneralTab';
import { DEFAULT_SETTINGS } from '../stores/settingsStore';
import type { UserSettings } from '../types/settings';

const ROW = 'Move the anchor while the Pi keeps watch (trial)';

beforeEach(() => {
    vi.stubGlobal('__BUILD_STAMP__', '2026-10-10 00:00Z');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function tab(settings: UserSettings) {
    const onSave = vi.fn();
    render(
        <GeneralTab
            settings={settings}
            onSave={onSave}
            onLocationSelect={vi.fn()}
            onDetectLocation={vi.fn()}
            onShowFactoryReset={vi.fn()}
        />,
    );
    return onSave;
}

describe('Settings → Preferences → Anchor watch', () => {
    it('has its own section with the one trial row, off by default, saying it is being checked', () => {
        expect(DEFAULT_SETTINGS.anchorPiMoveTrial).not.toBe(true);
        const onSave = tab(DEFAULT_SETTINGS);
        const heading = screen.getByRole('heading', { name: 'Anchor watch' });
        const section = heading.parentElement as HTMLElement;
        const toggle = within(section).getByRole('switch', { name: ROW });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(within(section).getByText(/Being checked aboard\. The Pi itself needs no update\./)).toBeTruthy();
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ anchorPiMoveTrial: true });
    });

    it('switches off again', () => {
        const onSave = tab({ ...DEFAULT_SETTINGS, anchorPiMoveTrial: true });
        const toggle = screen.getByRole('switch', { name: ROW });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ anchorPiMoveTrial: false });
    });
});
