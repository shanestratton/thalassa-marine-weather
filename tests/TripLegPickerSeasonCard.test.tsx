/**
 * The cyclone-season card (W1-12) where a skipper can actually see it: the
 * PLAN page's Trip · Legs modal (TripLegPicker). The Trip Overview sheet that
 * the plan named is reachable only from the parked legacy planner form
 * (LEGACY_PLANNER_FORM = false in RoutePlanner), so production never shows it.
 *
 * Pins: the card loads (chunk and IBTrACS JSON) only once a trip's legs open,
 * it reads the saved legs' own geometry (local, so it works offline), and it
 * sits after the leg rows and their actions, never in front of them.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/deepLink', () => ({ requestTracerOpen: vi.fn() }));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

// A fictional two-leg trip across a fictional South Pacific box.
vi.mock('../services/routeTracer', () => {
    const legs = [
        {
            id: 'trip-a',
            name: 'Harbour - Bay Point (1st Leg)',
            createdAt: '2026-07-23T00:00:00.000Z',
            points: [
                { lat: -17.5, lon: 166.5 },
                { lat: -17.5, lon: 167.2 },
            ],
            tripId: 'trip-a',
            legOrdinal: 1,
            destName: 'Bay Point',
        },
        {
            id: 'trip-a-leg-2',
            name: 'Bay Point - Sandy Cove (2nd Leg)',
            createdAt: '2026-07-23T00:00:00.000Z',
            points: [
                { lat: -17.5, lon: 167.2 },
                { lat: -17.5, lon: 168.0 },
            ],
            tripId: 'trip-a',
            legOrdinal: 2,
        },
    ];
    return {
        loadSavedTraces: vi.fn(() => legs),
        groupTracesByTrip: vi.fn(() => [{ key: 'trip-a', label: 'Harbour - Sandy Cove (2 legs)', legs }]),
        nextLegSeed: vi.fn(() => ({ ordinal: 3, fromName: 'Sandy Cove' })),
        ordinalLegLabel: vi.fn(() => '3rd Leg'),
    };
});

const fetchRoutesAndTracks = vi.fn();
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: (...args: unknown[]) => fetchRoutesAndTracks(...args),
}));

import { TripLegPicker } from '../components/passage/TripLegPicker';
import { __resetTcClimatologyCacheForTests } from '../services/climatology/tcClimatology';

const cell = (months: Record<number, string>): string =>
    Array.from({ length: 12 }, (_, m) => months[m] ?? '').join('|');

const CLIMATOLOGY = {
    format: 'thalassa.tc-climatology',
    version: 1,
    source: 'NOAA IBTrACS v04r01',
    credit: "NOAA's International Best Track Archive for Climate Stewardship (IBTrACS) v04r01, accessed 2026-10-08",
    accessed: '2026-10-08',
    firstYear: 1991,
    lastYear: 2024,
    boxDeg: 5,
    minWindKt: 34,
    storms: 6,
    idWidth: 2,
    cells: { '-20,165': cell({ 1: 'AAABACADAE', 6: 'AF' }) },
};

beforeEach(() => {
    __resetTcClimatologyCacheForTests();
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(CLIMATOLOGY), { status: 200 })),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('TripLegPicker — cyclone season for the trip', () => {
    it('shows the season strip in the legs modal, loaded only once the legs open', async () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        expect(fetch).not.toHaveBeenCalled();

        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'trip-a' },
        });
        const dialog = screen.getByRole('dialog', { name: /Harbour - Sandy Cove/ });
        const strip = await within(dialog).findByRole('list', { name: /cyclones near this route by month/i });
        expect(strip.querySelectorAll('li')[1]).toHaveAccessibleName(/February: 5 storms in 34 years.*cyclone season/);
        expect(within(dialog).getByText(/no departure date yet/i)).toBeInTheDocument();
        expect(within(dialog).getByText(/climate, not a forecast; storm counts, not intensities/i)).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledWith('/climatology/tc-monthly-5deg.json');
        // The saved legs carry their own geometry: no saved-routes lookup, so it works offline.
        expect(fetchRoutesAndTracks).not.toHaveBeenCalled();
    });

    it('sits after the legs and their actions, never in front of them', async () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'trip-a' },
        });
        const dialog = screen.getByRole('dialog', { name: /Harbour - Sandy Cove/ });
        const strip = await within(dialog).findByRole('list', { name: /cyclones near this route by month/i });
        const returnTrip = within(dialog).getByRole('button', { name: /^Plan the return trip/ });
        const nextLeg = within(dialog).getByRole('button', { name: /Plot the 3rd leg from Sandy Cove/ });
        for (const control of [returnTrip, nextLeg]) {
            expect(control.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
    });

    it('is lazy and fenced: the card chunk is a dynamic import behind its own quiet error boundary', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const src = readFileSync(resolve(__dirname, '../components/passage/TripLegPicker.tsx'), 'utf8');
        expect(src).toMatch(/React\.lazy\(\(\) => import\('\.\/SeasonRiskCard'\)\)/);
        expect(src).not.toMatch(/^import .*SeasonRiskCard/m);
        expect(src).not.toMatch(/tcClimatology/);
        expect(src).toMatch(
            /<ErrorBoundary boundaryName="SeasonRiskCard" fallback=\{RENDER_NOTHING\}>\s*<React\.Suspense fallback=\{null\}>\s*<SeasonRiskCard routeLegs=\{seasonLegs\} \/>/,
        );
    });
});
