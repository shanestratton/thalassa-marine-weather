import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { anchorZonePosition } from '../utils/anchorSafeZone';
const h = vi.hoisted(() => ({ token: vi.fn(), save: vi.fn() }));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { getSafeZoneEditToken: h.token, updateSafeZone: h.save },
}));
import AnchorSafeZoneSheet from '../components/anchor-watch/AnchorSafeZoneSheet';

const anchor = { latitude: -27, longitude: 153, timestamp: 1 };
const polygon = {
    version: 1 as const,
    kind: 'polygon' as const,
    anchor: { latitude: anchor.latitude, longitude: anchor.longitude },
    vertices: [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
    ].map(([x, y]) => anchorZonePosition(anchor, x, y)!),
};
const snapshot: AnchorWatchSnapshot = {
    state: 'watching',
    anchorPosition: anchor,
    swingRadius: 60,
    safeZone: polygon,
    vesselPosition: { ...anchor, accuracy: 1, heading: 0, speed: 0 },
    distanceFromAnchor: 0,
    maxDistanceRecorded: 0,
    bearingToAnchor: 0,
    config: { rodeLength: 50, waterDepth: 10, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
    positionHistory: [],
    alarmTriggeredAt: null,
    alarmCause: null,
    watchStartedAt: anchor.timestamp,
    gpsAccuracy: 1,
    gpsQuality: 'precision',
    gpsQualityLabel: 'Synthetic fix',
    guardianStatus: 'idle',
    setupError: null,
};
beforeEach(() => {
    h.token.mockReset().mockResolvedValue('watch-token');
    h.save.mockReset().mockResolvedValue({ ok: true });
});
describe('explicit manual anchor-area editor', () => {
    it('saves the admitted manual polygon only after the explicit button tap, with its captured lease', async () => {
        const close = vi.fn();
        render(<AnchorSafeZoneSheet snapshot={snapshot} onClose={close} readToken={h.token} onSave={h.save} />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Use safe area' })).toBeEnabled());
        expect(h.save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Use safe area' }));
        await waitFor(() => expect(h.save).toHaveBeenCalledWith(polygon, 'watch-token'));
        expect(close).toHaveBeenCalledOnce();
    });
    it('shows a refused stale lease without closing and has an explicit circle-only recovery path', async () => {
        h.save.mockResolvedValueOnce({ ok: false, error: 'The vessel changed; open the editor again.' });
        const close = vi.fn();
        render(<AnchorSafeZoneSheet snapshot={snapshot} onClose={close} readToken={h.token} onSave={h.save} />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Use safe area' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Use safe area' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('vessel changed');
        expect(close).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Use circle only' }));
        await waitFor(() => expect(h.save).toHaveBeenLastCalledWith(null, 'watch-token'));
    });
    it('supports multiple true-bearing exclusions and refuses a missing numeric angle', async () => {
        render(
            <AnchorSafeZoneSheet
                snapshot={{ ...snapshot, safeZone: null }}
                onClose={vi.fn()}
                readToken={h.token}
                onSave={h.save}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Exclude wedges' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Use safe area' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Add exclusion wedge' }));
        expect(screen.getByRole('spinbutton', { name: 'Wedge 2 start true bearing' })).toBeVisible();
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Wedge 1 clockwise angle' }), {
            target: { value: '' },
        });
        expect(screen.getByRole('button', { name: 'Use safe area' })).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent('invalid true bearing or angle');
        await act(async () => {});
    });
});
