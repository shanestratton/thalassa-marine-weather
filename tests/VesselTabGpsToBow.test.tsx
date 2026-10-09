/**
 * Settings → Vessel → Dimensions: "GPS antenna to bow" (build 126, 126-07c).
 *
 * Where the boat's own GPS antenna is, measured back from the bow, for the
 * anchor watch. Stored in FEET like every other dimension, shown in the boat's
 * length unit, never more than her length (or 60 m when her length is not
 * known). No default: an empty field is no allowance at all.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ store: { settings: {} } as Record<string, unknown> }));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(mocks.store), {
        getState: () => mocks.store,
    }),
}));
vi.mock('../services/supabase', () => ({
    supabase: null,
    isSupabaseConfigured: () => false,
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getStatus: () => ({ reachable: false, lastCheck: 0, latencyMs: 0 }),
        ping: vi.fn(async () => ({ reachable: false, lastCheck: 0, latencyMs: 0 })),
    },
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => null }));
vi.mock('../services/VesselIdentityService', () => ({ saveIdentity: vi.fn() }));
vi.mock('../hooks/useKeyboardOffset', () => ({ useKeyboardOffset: () => 0 }));
vi.mock('../components/settings/YachtDatabaseSearch', () => ({ YachtDatabaseSearch: () => null }));

import { VesselTab } from '../components/settings/VesselTab';
import type { UserSettings } from '../types';
import type { VesselProfile } from '../types/vessel';

const FT = 0.3048;

function settingsFor(lengthUnit: 'm' | 'ft', vessel: Partial<VesselProfile> = {}): UserSettings {
    return {
        units: { speed: 'kts', length: lengthUnit, distance: 'nm', temp: 'C', waveHeight: 'm' },
        vesselUnits: { length: lengthUnit, beam: lengthUnit, draft: lengthUnit, displacement: 'kg' },
        vessel: {
            name: 'Kotare',
            type: 'sail',
            length: 14 / FT,
            beam: 4.2 / FT,
            draft: 2.1 / FT,
            displacement: 9000,
            maxWaveHeight: 0,
            cruisingSpeed: 0,
            ...vessel,
        },
    } as unknown as UserSettings;
}

const field = () => screen.getByRole('spinbutton', { name: 'GPS antenna to bow' });

function enter(value: string) {
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value } });
    fireEvent.blur(field());
}

describe('VesselTab: GPS antenna to bow', () => {
    beforeEach(() => {
        mocks.store.settings = {};
    });

    it('sits in Dimensions after Air draft, empty until entered, and says what it is for', () => {
        render(<VesselTab settings={settingsFor('m')} onSave={vi.fn()} />);
        const fields = screen.getAllByRole('spinbutton').map((input) => input.getAttribute('aria-label'));
        expect(fields.indexOf('GPS antenna to bow')).toBe(fields.indexOf('Air draft') + 1);
        expect(field()).toHaveValue(null);
        expect(screen.getByRole('combobox', { name: 'GPS antenna to bow unit' })).toHaveValue('m');
        expect(field()).toHaveAccessibleDescription(
            /Where the boat’s GPS antenna is, measured back from the bow\. Used by the anchor watch\./,
        );
    });

    it('12 m is stored as 39.37 ft, like every other dimension', () => {
        const onSave = vi.fn();
        render(<VesselTab settings={settingsFor('m')} onSave={onSave} />);
        enter('12');
        expect(onSave).toHaveBeenLastCalledWith(
            expect.objectContaining({ vessel: expect.objectContaining({ gpsToBow: 39.37 }) }),
        );
    });

    it('shows back in metres, and in feet', () => {
        const { unmount } = render(<VesselTab settings={settingsFor('m', { gpsToBow: 39.37 })} onSave={vi.fn()} />);
        expect(field()).toHaveValue(12);
        unmount();
        render(<VesselTab settings={settingsFor('ft', { gpsToBow: 39.37 })} onSave={vi.fn()} />);
        expect(field()).toHaveValue(39.37);
        expect(screen.getByRole('combobox', { name: 'GPS antenna to bow unit' })).toHaveValue('ft');
    });

    it('is never more than her length: 20 m on a 14 m boat is kept as 14 m', () => {
        const onSave = vi.fn();
        render(<VesselTab settings={settingsFor('m')} onSave={onSave} />);
        enter('20');
        const saved = onSave.mock.lastCall?.[0]?.vessel?.gpsToBow;
        expect(saved * FT).toBeCloseTo(14, 1);
    });

    it('with no length known, never more than 60 m', () => {
        const onSave = vi.fn();
        render(<VesselTab settings={settingsFor('m', { length: 0 })} onSave={onSave} />);
        enter('75');
        const saved = onSave.mock.lastCall?.[0]?.vessel?.gpsToBow;
        expect(saved * FT).toBeCloseTo(60, 1);
    });
});
