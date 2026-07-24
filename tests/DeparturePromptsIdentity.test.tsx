import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const departurePromptMocks = vi.hoisted(() => ({
    updateSettings: vi.fn(),
    markLiveTrickleFreshStart: vi.fn(),
    getPlanLinks: vi.fn(),
    setVoyagePlanLink: vi.fn(),
    fetchRoutesAndTracks: vi.fn(),
    suggestPlanForDeparture: vi.fn(),
    startFollowing: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: unknown) => unknown) =>
        selector({
            settings: { liveTrackShare: false },
            updateSettings: departurePromptMocks.updateSettings,
        }),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getTrackingStatus: vi.fn(() => ({ isTracking: true })),
        getCurrentVoyageId: vi.fn(() => 'voyage-a'),
        onTrackingStateChange: vi.fn(() => vi.fn()),
        getOfflineEntries: vi.fn().mockResolvedValue([{ voyageId: 'voyage-a', latitude: -27.47, longitude: 153.03 }]),
    },
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: {
        getConfig: vi.fn().mockResolvedValue({ enabled: true }),
        getPlanLinks: departurePromptMocks.getPlanLinks,
        setVoyagePlanLink: departurePromptMocks.setVoyagePlanLink,
        lastError: null,
    },
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: departurePromptMocks.fetchRoutesAndTracks,
}));

vi.mock('../services/shiplog/planMatcher', () => ({
    suggestPlanForDeparture: departurePromptMocks.suggestPlanForDeparture,
}));

vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: {
        getState: () => ({ startFollowing: departurePromptMocks.startFollowing }),
    },
}));

vi.mock('../services/shiplog/TrackingStateStore', () => ({
    getLastPosition: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/shiplog/LiveTrickle', () => ({
    markLiveTrickleFreshStart: departurePromptMocks.markLiveTrickleFreshStart,
}));

vi.mock('../components/Toast', () => ({
    useToast: () => ({
        success: departurePromptMocks.toastSuccess,
        error: departurePromptMocks.toastError,
    }),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { DeparturePrompts } from '../components/vessel/DeparturePrompts';

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    departurePromptMocks.updateSettings.mockResolvedValue(undefined);
    departurePromptMocks.markLiveTrickleFreshStart.mockResolvedValue(undefined);
    departurePromptMocks.getPlanLinks.mockResolvedValue(new Map());
    departurePromptMocks.setVoyagePlanLink.mockResolvedValue(true);
    departurePromptMocks.fetchRoutesAndTracks.mockResolvedValue({ routes: [], tracks: [] });
    departurePromptMocks.suggestPlanForDeparture.mockReturnValue(null);
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('DeparturePrompts identity handoff', () => {
    it('does not apply account-A live-share consent to account B while the trickle module loads', async () => {
        render(<DeparturePrompts />);

        const share = await screen.findByRole('button', { name: 'Share live' });
        fireEvent.click(share);
        act(() => {
            setAuthIdentityScope('account-b');
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(departurePromptMocks.updateSettings).toHaveBeenCalledWith({ liveTrackShare: true });
        expect(departurePromptMocks.markLiveTrickleFreshStart).not.toHaveBeenCalled();
        expect(departurePromptMocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('starts local follow mode with the selected passage exact geometry before linking it publicly', async () => {
        const route: RouteOrTrack = {
            id: 'planned-moreton',
            label: 'Manly → Moreton Island',
            sublabel: 'Saved passage',
            points: [
                { lat: -27.455, lon: 153.19 },
                { lat: -27.31, lon: 153.28 },
                { lat: -27.17, lon: 153.38 },
            ],
            bbox: [153.19, -27.455, 153.38, -27.17],
            timestamp: Date.parse('2026-07-25T00:00:00.000Z'),
            distanceNm: 23.4,
            durationHours: 4.5,
            isLocal: false,
            kind: 'sea',
        };
        departurePromptMocks.fetchRoutesAndTracks.mockResolvedValue({ routes: [route], tracks: [] });
        departurePromptMocks.suggestPlanForDeparture.mockReturnValue(route);

        render(<DeparturePrompts />);

        fireEvent.click(await screen.findByRole('button', { name: 'Keep private' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Link passage' }));

        await waitFor(() => expect(departurePromptMocks.startFollowing).toHaveBeenCalledTimes(1));
        const [followPlan, followedVoyageId, exactPoints] = departurePromptMocks.startFollowing.mock.calls[0];
        expect(followedVoyageId).toBe(route.id);
        expect(exactPoints).toEqual(route.points);
        expect(followPlan).toMatchObject({
            origin: 'Manly',
            destination: 'Moreton Island',
            routeGeoJSON: {
                geometry: {
                    coordinates: route.points.map((point) => [point.lon, point.lat]),
                },
            },
        });
        await waitFor(() => expect(departurePromptMocks.setVoyagePlanLink).toHaveBeenCalledWith('voyage-a', route.id));
    });
});
