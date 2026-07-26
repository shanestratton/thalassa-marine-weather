import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const readinessMocks = vi.hoisted(() => ({
    loadCardChecks: vi.fn(),
    upsertCheck: vi.fn(),
    clearChecks: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
    settings: {
        vessel: {
            name: 'Serene Summer',
            type: 'sail' as const,
            length: 55,
            beam: 16,
            draft: 7.9,
            displacement: 45_000,
            maxWaveHeight: 4,
            cruisingSpeed: 6.5,
        },
        vesselUnits: { length: 'ft' as const, beam: 'ft' as const, draft: 'ft' as const, displacement: 'lbs' as const },
        units: { speed: 'kts' as const },
    },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: settingsMocks.settings }),
}));

vi.mock('../services/ReadinessCheckService', () => ({
    ReadinessCheckService: readinessMocks,
}));

import { VesselProfileSummary } from '../components/passage/VesselProfileSummary';

describe('VesselProfileSummary passage confirmation', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-a');
        readinessMocks.loadCardChecks.mockReset().mockResolvedValue({});
        readinessMocks.upsertCheck.mockReset().mockResolvedValue(undefined);
        readinessMocks.clearChecks.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
    });

    it('starts a new route unconfirmed, then stores the skipper confirmation per passage', async () => {
        const onReviewedChange = vi.fn();
        const { rerender } = render(<VesselProfileSummary voyageId="new-route" onReviewedChange={onReviewedChange} />);

        expect(screen.getByRole('button', { name: /confirm vessel for this passage/i })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(false));

        fireEvent.click(screen.getByRole('button', { name: /confirm vessel for this passage/i }));

        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));
        expect(screen.getByRole('button', { name: /vessel confirmed for this passage/i })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(readinessMocks.upsertCheck).toHaveBeenCalledWith(
            'new-route',
            'vessel_profile',
            'confirmed',
            true,
            expect.objectContaining({ confirmed_at: expect.any(String) }),
        );

        rerender(<VesselProfileSummary voyageId="another-new-route" onReviewedChange={onReviewedChange} />);
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(false));
        expect(screen.getByRole('button', { name: /confirm vessel for this passage/i })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
    });

    it('restores an explicit confirmation when a saved route is reopened', async () => {
        readinessMocks.loadCardChecks.mockImplementation(async (voyageId: string) =>
            voyageId === 'saved-route' ? { confirmed: { checked: true } } : {},
        );
        const onReviewedChange = vi.fn();

        render(<VesselProfileSummary voyageId="saved-route" onReviewedChange={onReviewedChange} />);

        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));
        expect(screen.getByRole('button', { name: /vessel confirmed for this passage/i })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });
});
