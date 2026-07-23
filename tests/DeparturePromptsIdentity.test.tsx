import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const departurePromptMocks = vi.hoisted(() => ({
    updateSettings: vi.fn(),
    markLiveTrickleFreshStart: vi.fn(),
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
        getPlanLinks: vi.fn().mockResolvedValue(new Map()),
        setVoyagePlanLink: vi.fn(),
        lastError: null,
    },
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: vi.fn().mockResolvedValue({ routes: [], tracks: [] }),
}));

vi.mock('../services/shiplog/planMatcher', () => ({
    suggestPlanForDeparture: vi.fn(() => null),
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
});
