/**
 * PassageKitPrompt — the amber passage warning, deterministic and polite.
 *
 * Born of Shane 2026-08-25: "i selected the newport, to coral sea route,
 * but no message about it being a passage??" — the card now fires the
 * moment a passage-grade route is COMMITTED (followed), not only at
 * tracking start; it is amber with a Passage planning button; it is never
 * compulsory; and one route geometry warns exactly once no matter how many
 * triggers see it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const setPage = vi.fn();

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getTrackingStatus: () => ({ isTracking: false }),
        getCurrentVoyageId: () => undefined,
        onTrackingStateChange: () => () => {},
    },
}));
vi.mock('../stores/uiStore', () => ({
    useUIStore: (sel: (s: { setPage: (p: string) => void }) => unknown) => sel({ setPage }),
}));
vi.mock('../stores/PassageStore', () => ({
    PassageStore: { getState: () => ({}) },
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

interface FollowState {
    isFollowing: boolean;
    routeCoords: { lat: number; lon: number }[];
    voyageId: string | null;
    startedAt: string | null;
}
const followStore = create<FollowState>(() => ({
    isFollowing: false,
    routeCoords: [],
    voyageId: null,
    startedAt: null,
}));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: Object.assign(
        (sel?: (s: FollowState) => unknown) => (sel ? followStore(sel) : followStore()),
        {
            getState: () => followStore.getState(),
            setState: (p: Partial<FollowState>) => followStore.setState(p),
        },
    ),
}));

import { PassageKitPrompt } from '../components/vessel/PassageKitPrompt';

// Newport → up past Fraser: ~200 NM, guaranteed overnight at the 6 kn floor.
const PASSAGE_ROUTE = [
    { lat: -27.2, lon: 153.09 },
    { lat: -24.0, lon: 152.6 },
];
// A morning harbour hop — under an hour, no darkness.
const DAY_ROUTE = [
    { lat: -27.2, lon: 153.09 },
    { lat: -27.15, lon: 153.1 },
];

beforeEach(() => {
    vi.useFakeTimers();
    // 10:00 local — a day route classified now cannot brush civil dusk.
    vi.setSystemTime(new Date(2026, 7, 26, 10, 0, 0));
    followStore.setState({ isFollowing: false, routeCoords: [], voyageId: null, startedAt: null });
    setPage.mockClear();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('PassageKitPrompt — route-committed trigger', () => {
    it('warns the moment a passage-grade route is followed — no tracking required', () => {
        render(<PassageKitPrompt />);
        expect(screen.queryByText(/This is a passage/)).toBeNull();

        act(() => {
            followStore.setState({
                isFollowing: true,
                routeCoords: PASSAGE_ROUTE,
                voyageId: 'v1',
                startedAt: '2026-08-26T00:00:00Z',
            });
        });

        expect(screen.getByText(/This is a passage/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Passage planning/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Not now/i })).toBeInTheDocument();
    });

    it('a day hop stays silent', () => {
        render(<PassageKitPrompt />);
        act(() => {
            followStore.setState({ isFollowing: true, routeCoords: DAY_ROUTE, startedAt: '2026-08-26T00:00:00Z' });
        });
        expect(screen.queryByText(/This is a passage/)).toBeNull();
    });

    it('Passage planning navigates to the crew page; Not now just closes — never compulsory', () => {
        render(<PassageKitPrompt />);
        act(() => {
            followStore.setState({ isFollowing: true, routeCoords: PASSAGE_ROUTE, startedAt: 'x' });
        });
        fireEvent.click(screen.getByRole('button', { name: /Passage planning/i }));
        expect(setPage).toHaveBeenCalledWith('crew');
        expect(screen.queryByText(/This is a passage/)).toBeNull();
    });

    it('one geometry warns once — re-committing the same route stays quiet after Not now', () => {
        render(<PassageKitPrompt />);
        act(() => {
            followStore.setState({ isFollowing: true, routeCoords: PASSAGE_ROUTE, startedAt: 'a' });
        });
        fireEvent.click(screen.getByRole('button', { name: /Not now/i }));
        expect(screen.queryByText(/This is a passage/)).toBeNull();

        act(() => {
            followStore.setState({ isFollowing: false });
        });
        act(() => {
            followStore.setState({ isFollowing: true, routeCoords: [...PASSAGE_ROUTE], startedAt: 'b' });
        });
        expect(screen.queryByText(/This is a passage/)).toBeNull();
    });
});
