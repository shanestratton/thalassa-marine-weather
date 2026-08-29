/**
 * The switch for the boat's always-on track.
 *
 * The point of this card is that it does NOT collapse three different states
 * into one. "We couldn't ask" is not "it's off", and "switched on" is not
 * "running" — and a skipper who is told the wrong one of those may turn on
 * something already recording, or trust a recorder that has stopped.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPiTrackStatus, setPiTrackRecording } = vi.hoisted(() => ({
    getPiTrackStatus: vi.fn(),
    setPiTrackRecording: vi.fn(),
}));

vi.mock('../services/piTrackRecorder', () => ({ getPiTrackStatus, setPiTrackRecording }));

import { PiTrackRecorderCard } from '../components/settings/PiTrackRecorderCard';

const T0 = Date.parse('2026-08-01T00:00:00Z');

const status = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    running: true,
    lastOutcome: 'logged',
    writtenThisSession: 12,
    stored: { points: 4321, firstMs: T0, lastMs: T0 + 3 * 86_400_000, bytes: 2 * 1024 * 1024 },
    ...over,
});

beforeEach(() => {
    getPiTrackStatus.mockReset();
    setPiTrackRecording.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('the boat track recorder card', () => {
    it('says it could not ASK, rather than claiming the recorder is off', async () => {
        getPiTrackStatus.mockResolvedValue(null);
        render(<PiTrackRecorderCard />);
        const card = await screen.findByTestId('pi-track-card');
        expect(card.textContent).toContain('Can’t reach the Pi');
        expect(card.textContent).toContain('doesn’t mean recording is off');
        // No switch to press: pressing one here would be acting on a state we
        // do not know.
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('shows what the boat is holding', async () => {
        getPiTrackStatus.mockResolvedValue(status());
        render(<PiTrackRecorderCard />);
        const card = await screen.findByTestId('pi-track-card');
        expect(card.textContent).toContain('4,321 points');
        expect(card.textContent).toContain('3 days of track');
        expect(card.textContent).toContain('2.0 MB');
        expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    });

    it('flags switched-on-but-not-running instead of looking happy', async () => {
        getPiTrackStatus.mockResolvedValue(status({ running: false }));
        render(<PiTrackRecorderCard />);
        const card = await screen.findByTestId('pi-track-card');
        expect(card.textContent).toContain('isn’t running');
    });

    it('does not flag it when the recorder is simply off', async () => {
        getPiTrackStatus.mockResolvedValue(status({ enabled: false, running: false }));
        render(<PiTrackRecorderCard />);
        const card = await screen.findByTestId('pi-track-card');
        expect(card.textContent).not.toContain('isn’t running');
        expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    });

    it('asks the Pi to start, and shows what the Pi says afterwards', async () => {
        // Not an echo of the request: if the write landed but the loop failed
        // to start, the skipper should see that.
        getPiTrackStatus.mockResolvedValue(status({ enabled: false, running: false }));
        setPiTrackRecording.mockResolvedValue(status({ enabled: true, running: false }));
        render(<PiTrackRecorderCard />);
        fireEvent.click(await screen.findByRole('switch'));
        await waitFor(() => expect(setPiTrackRecording).toHaveBeenCalledWith(true));
        await waitFor(() => expect(screen.getByTestId('pi-track-card').textContent).toContain('isn’t running'));
    });

    it('renders nothing until it has actually asked', async () => {
        // A card that flashes "unavailable" every time settings opens is noise.
        let resolve: (v: unknown) => void = () => {};
        getPiTrackStatus.mockReturnValue(new Promise((r) => (resolve = r)));
        const { container } = render(<PiTrackRecorderCard />);
        expect(container.textContent).toBe('');
        resolve(status());
        await screen.findByTestId('pi-track-card');
    });
});
