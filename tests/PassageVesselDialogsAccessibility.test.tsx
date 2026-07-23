import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Voyage } from '../services/VoyageService';

const tripGroup = {
    key: 'trip-1',
    label: 'Brisbane → Cairns',
    legs: [
        {
            id: 'leg-1',
            name: 'Brisbane → Moreton',
            points: [
                { lat: -27.47, lon: 153.02 },
                { lat: -27.1, lon: 153.3 },
            ],
        },
    ],
};

const tripOverview = {
    name: 'Brisbane → Cairns',
    legs: [
        {
            legNumber: 1,
            departurePort: 'Brisbane',
            arrivalPort: 'Cairns',
            distanceNm: 730,
            durationHours: 96,
            departureDateIso: null,
            arrivalCountry: 'Australia',
        },
    ],
    totalDistanceNm: 730,
    totalDurationHours: 96,
    countries: ['Australia'],
    earliestDepartureIso: null,
    latestArrivalIso: null,
};

vi.mock('../services/routeTracer', () => ({
    loadSavedTraces: vi.fn(() => tripGroup.legs),
    groupTracesByTrip: vi.fn(() => [tripGroup]),
    nextLegSeed: vi.fn(() => ({ ordinal: 2, fromName: 'Moreton' })),
    ordinalLegLabel: vi.fn(() => '2nd Leg'),
}));

vi.mock('../services/deepLink', () => ({
    requestTracerOpen: vi.fn(),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            vessel: {
                name: 'Test Vessel',
                crewCount: 2,
            },
        },
    }),
}));

vi.mock('../services/TripOverviewService', () => ({
    buildTripOverview: vi.fn(() => tripOverview),
    enrichTripWithLiveData: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../services/CountrySnippetService', () => ({
    resolveCountrySnippets: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('../services/VoyageService', () => ({
    getAllVoyagesForUser: vi.fn(() => new Promise(() => undefined)),
    deleteVoyageById: vi.fn(),
    getDraftVoyages: vi.fn(() => new Promise(() => undefined)),
    getActiveVoyage: vi.fn(() => new Promise(() => undefined)),
    castOff: vi.fn(),
    endVoyage: vi.fn(),
    createVoyage: vi.fn(),
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: vi.fn(() => Promise.resolve({ routes: [], tracks: [] })),
}));

vi.mock('../services/VoyageLegService', () => ({
    getActiveLeg: vi.fn(() => null),
    getLegsForVoyage: vi.fn(() => []),
    closeLeg: vi.fn(),
    startLeg: vi.fn(),
    getLegSummary: vi.fn(),
}));

vi.mock('../services/ChatService', () => ({
    ChatService: {
        createVoyageChannel: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: null,
}));

vi.mock('../services/CrewService', () => ({
    redeemManifestCode: vi.fn(),
}));

vi.mock('../services/vessel/SyncService', () => ({
    syncNow: vi.fn(() => Promise.resolve()),
}));

import { TripLegPicker } from '../components/passage/TripLegPicker';
import { TripOverviewSheet } from '../components/passage/TripOverviewSheet';
import { VoyageCleanupSheet } from '../components/passage/VoyageCleanupSheet';
import { JoinVessel } from '../components/crew/JoinVessel';
import { CastOffPanel } from '../components/vessel/CastOffPanel';

const voyage: Voyage = {
    id: 'voyage-1',
    user_id: 'user-1',
    vessel_id: 'vessel-1',
    voyage_name: 'Brisbane → Cairns',
    departure_port: 'Brisbane',
    destination_port: 'Cairns',
    departure_time: null,
    eta: null,
    crew_count: 2,
    status: 'planning',
    weather_master_id: 'user-1',
    notes: null,
    created_at: '2026-07-23T00:00:00Z',
    updated_at: '2026-07-23T00:00:00Z',
};

afterEach(() => {
    localStorage.clear();
});

describe('passage and vessel dialog accessibility', () => {
    it('contains the trip-leg picker and restores focus to its select after Escape', () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        const picker = screen.getByRole('combobox', { name: 'Pick a trip or route to continue' });
        picker.focus();
        fireEvent.change(picker, { target: { value: 'trip-1' } });

        const close = screen.getByRole('button', { name: 'Close' });
        expect(screen.getByRole('dialog', { name: '🧩 Brisbane → Cairns' })).toContainElement(close);
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(picker).toHaveFocus();
    });

    it('contains the trip overview and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Open trip overview</button>
                <TripOverviewSheet isOpen={false} onClose={onClose} legs={[voyage]} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open trip overview' });
        opener.focus();

        rerender(
            <>
                <button>Open trip overview</button>
                <TripOverviewSheet isOpen onClose={onClose} legs={[voyage]} />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close trip overview' });
        expect(screen.getByRole('dialog', { name: 'Trip Overview Brisbane → Cairns' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open trip overview</button>
                <TripOverviewSheet isOpen={false} onClose={onClose} legs={[voyage]} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('contains saved-trip cleanup and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Manage trips</button>
                <VoyageCleanupSheet isOpen={false} onClose={onClose} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Manage trips' });
        opener.focus();

        rerender(
            <>
                <button>Manage trips</button>
                <VoyageCleanupSheet isOpen onClose={onClose} />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close cleanup sheet' });
        expect(screen.getByRole('dialog', { name: 'Manage Saved Trips' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Manage trips</button>
                <VoyageCleanupSheet isOpen={false} onClose={onClose} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('opens vessel joining on the first code field and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Join crew</button>);
        const opener = screen.getByRole('button', { name: 'Join crew' });
        opener.focus();

        rerender(
            <>
                <button>Join crew</button>
                <JoinVessel onJoined={vi.fn()} onClose={onClose} />
            </>,
        );
        const firstDigit = screen.getByRole('textbox', { name: 'Code digit 1' });
        expect(screen.getByRole('dialog', { name: 'Join a Vessel' })).toContainElement(firstDigit);
        expect(firstDigit).toHaveFocus();
        fireEvent.keyDown(firstDigit, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Join crew</button>);
        expect(opener).toHaveFocus();
    });

    it('contains cast-off and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open cast off</button>);
        const opener = screen.getByRole('button', { name: 'Open cast off' });
        opener.focus();

        rerender(
            <>
                <button>Open cast off</button>
                <CastOffPanel onClose={onClose} />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close dialog' });
        expect(screen.getByRole('dialog', { name: 'Select Voyage' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open cast off</button>);
        expect(opener).toHaveFocus();
    });
});
