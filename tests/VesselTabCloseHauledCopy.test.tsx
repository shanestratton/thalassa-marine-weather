/**
 * Settings → Vessel: "Closest true wind angle" says what really uses it
 * (build 126, 126-01b; roadmap: "The Instrument Panel stops claiming to call
 * 'In irons'").
 *
 * The help line promised that the Instrument Panel calls "In irons" and
 * "Pinching" against this angle. Nothing on the panel does: pointOfSail() has
 * no caller outside its tests. What does read it is the passage HUD's ETA and
 * Plan Your Day (closeHauledDegFor → routingSpeedModel), to time upwind legs.
 * Fictional boat 'Albatross'.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

const FT = 0.3048;

const SETTINGS = {
    units: { speed: 'kts', length: 'm', distance: 'nm', temp: 'C', waveHeight: 'm' },
    vesselUnits: { length: 'm', beam: 'm', draft: 'm', displacement: 'kg' },
    vessel: {
        name: 'Albatross',
        type: 'sail',
        riggingType: 'Sloop',
        length: 12 / FT,
        beam: 3.9 / FT,
        draft: 1.9 / FT,
        displacement: 8000,
        maxWaveHeight: 0,
        cruisingSpeed: 0,
    },
} as unknown as UserSettings;

describe('Vessel → Closest true wind angle', () => {
    it('names what uses it (the passage HUD and Plan Your Day), and promises no "In irons" call', () => {
        render(<VesselTab settings={SETTINGS} onSave={vi.fn()} />);
        const help = screen.getByText(/How close to the wind she sails\./);
        expect(help.textContent).toContain('The passage HUD and Plan Your Day use it to time upwind legs.');
        expect(help.textContent).not.toMatch(/Instrument Panel|In irons|Pinching/);
        // The rig default is still offered.
        expect(help.textContent).toMatch(/Blank uses the default for her rig \(\d+°\)/);
    });

    it('the field it fills says the same in the type it is declared on', () => {
        const types = readFileSync('types/vessel.ts', 'utf8');
        const doc = types.slice(
            types.lastIndexOf('/**', types.indexOf('closeHauledTwa?:')),
            types.indexOf('closeHauledTwa?:'),
        );
        expect(doc).not.toMatch(/Instrument Panel|In irons/);
        expect(doc).toMatch(/passage HUD/);
        expect(doc).toMatch(/Plan Your Day/);
    });
});
