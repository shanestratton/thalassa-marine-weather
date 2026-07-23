import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const cleanupMocks = vi.hoisted(() => ({
    getAllVoyagesForUser: vi.fn(),
    deleteVoyageById: vi.fn(),
    fetchRoutesAndTracks: vi.fn(),
    deleteRouteVoyage: vi.fn(),
}));

vi.mock('../services/VoyageService', () => ({
    getAllVoyagesForUser: cleanupMocks.getAllVoyagesForUser,
    deleteVoyageById: cleanupMocks.deleteVoyageById,
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: cleanupMocks.fetchRoutesAndTracks,
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        deleteVoyage: cleanupMocks.deleteRouteVoyage,
    },
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { VoyageCleanupSheet } from '../components/passage/VoyageCleanupSheet';

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    cleanupMocks.getAllVoyagesForUser.mockResolvedValue([]);
    cleanupMocks.fetchRoutesAndTracks.mockResolvedValue({
        routes: [
            {
                id: 'planned-account-a',
                label: 'Brisbane → Cairns',
                sublabel: '730 NM',
            },
        ],
        tracks: [],
    });
    cleanupMocks.deleteRouteVoyage.mockResolvedValue(true);
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('VoyageCleanupSheet identity handoff', () => {
    it('does not delete account A route data under account B while the logbook module loads', async () => {
        render(<VoyageCleanupSheet isOpen onClose={vi.fn()} />);

        await screen.findByText('Brisbane → Cairns');
        fireEvent.click(screen.getByRole('button', { name: /delete \(cascades to voyage row\)/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));
        act(() => {
            setAuthIdentityScope('account-b');
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(cleanupMocks.deleteRouteVoyage).not.toHaveBeenCalled();
    });
});
