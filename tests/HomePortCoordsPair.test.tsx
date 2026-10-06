/**
 * Settings → Home port writes the location box's name and its coordinates as
 * a pair, the rule locationPersistPatch already keeps for the Glass search.
 *
 * Obs opens where the location box points (Shane 2026-10-06: "if i put
 * hawaii in the glass page, when i go to the obs page, it should show me that
 * location from the get go"), trusting the saved coordinates for the saved
 * name. Typing a port wrote the name alone, so while following, the last GPS
 * fix stayed saved under the new name and Obs (and the next cold boot) opened
 * on that old fix instead of the port.
 */
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GeneralTab } from '../components/settings/GeneralTab';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';

beforeEach(async () => {
    vi.stubGlobal('__BUILD_STAMP__', '2026-10-06 00:00Z');
    await awaitSettingsLoaded();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('Settings → Home port keeps the name and coordinates together', () => {
    it('a typed port clears the coordinates saved for the previous selection', () => {
        const onSave = vi.fn();
        const settings = {
            ...useSettingsStore.getState().settings,
            defaultLocation: 'Current Location',
            // The last GPS fix, saved while following.
            defaultLocationCoords: { lat: -27.21, lon: 153.09 },
        };
        const view = render(
            <GeneralTab
                settings={settings}
                onSave={onSave}
                onLocationSelect={vi.fn()}
                onDetectLocation={vi.fn()}
                onShowFactoryReset={vi.fn()}
            />,
        );
        const field = view.container.querySelector('#settings-home-port') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'Hawaii' } });
        // Strict: an absent key would leave the old fix saved under the new name.
        expect(onSave.mock.lastCall?.[0]).toStrictEqual({
            defaultLocation: 'Hawaii',
            defaultLocationCoords: undefined,
        });
    });

    it('Pin here saves the fix it named, not just the name', () => {
        const modal = readFileSync('components/SettingsModal.tsx', 'utf8');
        const detect = modal.slice(
            modal.indexOf('const handleDetectLocation'),
            modal.indexOf('return true;', modal.indexOf('const handleDetectLocation')),
        );
        expect(detect).toContain(
            'onSave({ defaultLocation: resolvedName, defaultLocationCoords: { lat: latitude, lon: longitude } });',
        );
    });
});
