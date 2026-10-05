/**
 * "Help map the seabed" in Preferences: off by default, the whole explanation
 * beside the switch, one tap on, one tap off, and a dead control for crew and
 * for a signed-out phone.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useAuthStore } from '../stores/authStore';
import { SEABED_CONSENT_VERSION } from '../services/seabed/seabedCore';
import { readSeabedLocal, seabedDeviceId, writeSeabedLocal } from '../services/seabed/SeabedSettingsService';

const OWNER = '00000000-0000-4000-8000-000000000001';
const BOAT = '00000000-0000-4000-8000-0000000000b1';

const mocks = vi.hoisted(() => ({
    fleet: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    /** The owner's cloud row; undefined = the table is not there yet (before the push). */
    cloud: undefined as Record<string, unknown> | null | undefined,
    busFix: null as { rung: string; latitude: number; longitude: number } | null,
    sog: { value: null as number | null, lastUpdated: 0, freshness: 'dead' },
}));

vi.mock('../services/VesselFleetService', () => ({
    loadOwnedVesselFleet: mocks.fleet,
    loadCachedOwnedVesselFleet: vi.fn(async () => null),
}));

vi.mock('../services/PiPairingService', () => ({ getPairing: () => null }));

/** Before the migration is pushed every seabed table read fails the way PostgREST does; after, one row. */
vi.mock('../services/supabase', () => {
    const missing = { data: null, error: { code: 'PGRST205', message: 'relation not found' } };
    const answer = () => (mocks.cloud === undefined ? missing : { data: mocks.cloud, error: null });
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'update', 'insert']) builder[m] = () => builder;
    builder.maybeSingle = async () => answer();
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
    return {
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key',
        supabase: {
            from: () => builder,
            rpc: async () => missing,
            auth: {
                getSession: async () => ({ data: { session: null }, error: null }),
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
            },
        },
    };
});

vi.mock('../services/seabed/SeabedPhoneCapture', () => ({
    startSeabedPhoneCapture: mocks.start,
    stopSeabedPhoneCapture: mocks.stop,
    phoneSeabedQueue: vi.fn(async () => ({ soundings: 0, trackM: 0, full: false })),
}));

vi.mock('../services/boatPositionChain', () => ({ boatFix: vi.fn(async () => mocks.busFix) }));
vi.mock('../services/piTrackRecorder', () => ({ getPiLastRestingFix: vi.fn(async () => null) }));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: () => ({ sog: mocks.sog }) },
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { SeabedMappingSection } from '../components/settings/SeabedMappingSection';

const owned = {
    vessels: [
        {
            id: BOAT,
            owner_id: OWNER,
            profile: { name: 'Fictional', type: 'sail', length: 38, draft: 6.5 },
            revision: 1,
            updated_at: '2030-01-01T00:00:00Z',
            is_active: true,
            mmsiClaimed: null,
            releasedAt: null,
            releaseReason: null,
        },
    ],
    activeBoatId: BOAT,
};

const ZONE = { id: 'home-1', kind: 'home' as const, lat: -30.5, lon: 160.2, radius_m: 1000, jitter_m: 250 };

function localCopy(over: Partial<Parameters<typeof writeSeabedLocal>[0] & object> = {}) {
    return {
        boatId: BOAT,
        enabled: true,
        consentVersion: SEABED_CONSENT_VERSION,
        captureDeviceId: seabedDeviceId(),
        zones: [],
        sounderNote: null,
        updatedAt: Date.UTC(2030, 0, 1),
        pendingSync: false,
        dirty: [],
        known: true,
        ...over,
    };
}

describe('Help map the seabed', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(OWNER);
        act(() => useAuthStore.setState({ user: { id: OWNER } as never }));
        mocks.fleet.mockReset();
        mocks.start.mockClear();
        mocks.stop.mockClear();
        mocks.cloud = undefined;
        mocks.busFix = null;
        mocks.sog = { value: null, lastUpdated: 0, freshness: 'dead' };
    });
    afterEach(() => {
        act(() => useAuthStore.setState({ user: null }));
    });

    it('is off by default, with the plain explanation beside the switch', async () => {
        mocks.fleet.mockResolvedValue(owned);
        render(<SeabedMappingSection />);
        const toggle = await screen.findByRole('switch', { name: 'Help map the seabed' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(/never from the phone.s own GPS/)).toBeInTheDocument();
        expect(screen.getByText(/Nothing is shared yet/)).toBeInTheDocument();
        expect(screen.getByText(/where they may become free for anyone to use/)).toBeInTheDocument();
        expect(
            screen.getByText(/home berth, your private places, or where each trip starts and ends/),
        ).toBeInTheDocument();
    });

    it('crew see a dead switch: the skipper decides', async () => {
        mocks.fleet.mockResolvedValue({ vessels: [], activeBoatId: null });
        render(<SeabedMappingSection />);
        expect(await screen.findByText('Your skipper decides this.')).toBeInTheDocument();
    });

    it('one tap on makes this phone the logger on the current consent; one tap off stops and purges', async () => {
        mocks.fleet.mockResolvedValue(owned);
        render(<SeabedMappingSection />);
        await waitFor(() => expect(mocks.fleet).toHaveBeenCalled());
        const toggle = await screen.findByRole('switch', { name: 'Help map the seabed' });
        await act(async () => {
            fireEvent.click(toggle);
        });
        await waitFor(() => expect(readSeabedLocal()?.enabled).toBe(true));
        const local = readSeabedLocal()!;
        expect(local.boatId).toBe(BOAT);
        expect(local.consentVersion).toBe(SEABED_CONSENT_VERSION);
        expect(local.captureDeviceId).toBe(seabedDeviceId());
        expect(local.pendingSync).toBe(true); // no table yet: kept here, quietly
        await waitFor(() => expect(mocks.start).toHaveBeenCalled());
        await screen.findByText(/Seabed mapping: no soundings yet/);

        await act(async () => {
            fireEvent.click(screen.getByRole('switch', { name: 'Help map the seabed' }));
        });
        await waitFor(() => expect(readSeabedLocal()?.enabled).toBe(false));
        await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(true));
    });

    it("a device with no copy of its own shows the owner's setting from the cloud, zones and all", async () => {
        mocks.fleet.mockResolvedValue(owned);
        mocks.cloud = {
            boat_id: BOAT,
            enabled: true,
            consent_version: SEABED_CONSENT_VERSION,
            capture_device_id: null,
            privacy_zones: [ZONE],
            sounder_note: null,
            updated_at: '2030-01-01T00:00:00.000Z',
        };
        render(<SeabedMappingSection />);
        await waitFor(() =>
            expect(screen.getByRole('switch', { name: 'Help map the seabed' })).toHaveAttribute('aria-checked', 'true'),
        );
        expect(screen.getByText(/Home berth: set/)).toBeInTheDocument();
        expect(readSeabedLocal()?.zones).toEqual([ZONE]);
        await waitFor(() => expect(mocks.start).toHaveBeenCalled()); // an enabled copy starts the capture
    });

    it('the sounder note comes from the record, and leaving the field unchanged saves nothing', async () => {
        mocks.fleet.mockResolvedValue(owned);
        mocks.cloud = {
            boat_id: BOAT,
            enabled: true,
            consent_version: SEABED_CONSENT_VERSION,
            capture_device_id: null,
            privacy_zones: [ZONE],
            sounder_note: 'Fictional DST-1',
            updated_at: '2030-01-01T00:00:00.000Z',
        };
        render(<SeabedMappingSection />);
        const field = await screen.findByDisplayValue('Fictional DST-1');
        await act(async () => {
            fireEvent.focus(field);
            fireEvent.blur(field);
        });
        expect(readSeabedLocal()).toMatchObject({ sounderNote: 'Fictional DST-1', pendingSync: false, dirty: [] });
        await waitFor(() => expect(mocks.start).toHaveBeenCalled());
    });

    it('a boat that is no longer yours still has a live switch to stop logging', async () => {
        mocks.fleet.mockResolvedValue({ vessels: [], activeBoatId: null });
        writeSeabedLocal(localCopy());
        render(<SeabedMappingSection />);
        expect(await screen.findByText(/isn.t your active boat/)).toBeInTheDocument();
        const toggle = screen.getByRole('switch', { name: 'Help map the seabed' });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        await act(async () => {
            fireEvent.click(toggle);
        });
        await waitFor(() => expect(readSeabedLocal()?.enabled).toBe(false));
        await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(true));
    });

    it('where she lies at switch-on is a private place until the skipper says it is home', async () => {
        mocks.fleet.mockResolvedValue(owned);
        mocks.busFix = { rung: 'bus', latitude: -30.5, longitude: 160.2 };
        mocks.sog = { value: 0.1, lastUpdated: Date.now(), freshness: 'live' };
        render(<SeabedMappingSection />);
        await waitFor(() => expect(mocks.fleet).toHaveBeenCalled());
        await act(async () => {
            fireEvent.click(await screen.findByRole('switch', { name: 'Help map the seabed' }));
        });
        expect(await screen.findByText(/Private place: where she.s lying now/)).toBeInTheDocument();
        expect(screen.getByText('Set your home berth')).toBeInTheDocument();
        const zones = readSeabedLocal()?.zones ?? [];
        expect(zones).toHaveLength(1);
        expect(zones[0].kind).toBe('marked');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Make this her home berth' }));
        });
        await waitFor(() => expect(readSeabedLocal()?.zones[0].kind).toBe('home'));
        expect(screen.getByText(/Home berth: set/)).toBeInTheDocument();
    });

    it('a home made wide cannot be shrunk past the jitter it was made with', async () => {
        mocks.fleet.mockResolvedValue(owned);
        writeSeabedLocal(localCopy({ zones: [{ ...ZONE, radius_m: 2000, jitter_m: 500 }] }));
        render(<SeabedMappingSection />);
        const half = await screen.findByRole('button', { name: '0.5 km' });
        expect(half).toBeDisabled();
        expect(screen.getByRole('button', { name: '1 km' })).not.toBeDisabled();
        await waitFor(() => expect(mocks.start).toHaveBeenCalled());
    });

    it('signed out: a dead switch that says why', () => {
        act(() => useAuthStore.setState({ user: null }));
        writeSeabedLocal(null);
        render(<SeabedMappingSection />);
        expect(screen.getByText(/Sign in to help map the seabed/)).toBeInTheDocument();
    });
});
