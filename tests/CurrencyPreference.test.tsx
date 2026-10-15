/**
 * Settings → Preferences → Currency (132-B17, binder audit GAL-09): the
 * Grocery list's prices follow the phone's region until a currency is picked
 * here, and the pick rides the account's settings to every phone (the
 * user_settings merge passes every key but the vessel and entitlement ones).
 * "Follow this phone" writes null, not undefined, so the cloud patch carries
 * the key and the other phones follow too. No database change: it is one more
 * key in the settings the app already syncs.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../stores/settingsStore';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { GeneralTab } from '../components/settings/GeneralTab';
import { CURRENCY_CHOICES } from '../utils/money';

function preferences(settings = DEFAULT_SETTINGS) {
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
    return { onSave, select: screen.getByRole('combobox', { name: 'Grocery list prices' }) as HTMLSelectElement };
}

describe('Preferences → Currency', () => {
    beforeEach(() => {
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-15 00:00Z');
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-PF']);
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('with none picked, it follows the phone, and says which currency that is', () => {
        const { select } = preferences();
        expect(screen.getByRole('heading', { name: 'Currency' })).toBeInTheDocument();
        expect(select.value).toBe('');
        expect(select.selectedOptions[0].textContent).toBe('Follow this phone (XPF)');
        expect(select).toHaveAccessibleDescription(
            'New items and prices use it. Items already on the list keep the currency they were added in.',
        );
    });

    it('offers every currency by name and code, the Pacific first', () => {
        const { select } = preferences();
        const options = [...select.options].map((option) => option.textContent);
        expect(options).toHaveLength(CURRENCY_CHOICES.length + 1);
        expect(options.slice(1, 4)).toEqual([
            'Australian dollar (AUD)',
            'New Zealand dollar (NZD)',
            'Fijian dollar (FJD)',
        ]);
        expect(options).toContain('US dollar (USD)');
        expect(options).toContain('Euro (EUR)');
    });

    it('a pick saves its code; "Follow this phone" saves null so other phones follow too', () => {
        const { onSave, select } = preferences();
        fireEvent.change(select, { target: { value: 'TOP' } });
        expect(onSave).toHaveBeenLastCalledWith({ currency: 'TOP' });
        fireEvent.change(select, { target: { value: '' } });
        expect(onSave).toHaveBeenLastCalledWith({ currency: null });
    });

    it('shows the saved pick, one this build does not list included', () => {
        cleanup();
        let { select } = preferences({ ...DEFAULT_SETTINGS, currency: 'NZD' });
        expect(select.value).toBe('NZD');
        cleanup();
        ({ select } = preferences({ ...DEFAULT_SETTINGS, currency: 'INR' }));
        expect(select.value).toBe('INR');
        expect(select.selectedOptions[0].textContent).toBe('INR');
    });

    it('sits with Units, the first thing after them in Preferences', () => {
        preferences();
        const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent?.trim());
        expect(headings.indexOf('Currency')).toBe(headings.indexOf('Units') + 1);
    });
});
