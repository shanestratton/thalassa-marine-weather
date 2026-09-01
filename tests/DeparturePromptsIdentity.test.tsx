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
    },
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: {
        getConfig: vi.fn().mockResolvedValue({ enabled: true }),
        lastError: null,
    },
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

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
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

    it('never shows the superseded "Link passage" suggestion banner', async () => {
        // TOMBSTONE (removed 2026-08-02). The "Sailing <plan>? / Link passage"
        // banner duplicated the cast-off "Following a route?" sheet: its
        // nearest-departure heuristic reliably guessed the FIRST row of the
        // list the skipper had just answered, and it re-asked the question
        // after the sheet closed. The sheet owns the question now; a missed
        // voyage is retro-linked from Settings → Voyage Log. This component
        // asks exactly one thing at departure: share live or keep private.
        render(<DeparturePrompts />);

        await screen.findByRole('button', { name: 'Share live' });
        expect(screen.queryByRole('button', { name: 'Link passage' })).not.toBeInTheDocument();
        expect(screen.queryByText(/^Sailing /)).not.toBeInTheDocument();

        // Answering the one kept question must not reveal a second one.
        fireEvent.click(screen.getByRole('button', { name: 'Keep private' }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByRole('button', { name: 'Link passage' })).not.toBeInTheDocument();
    });
});
