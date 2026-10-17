import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const load = vi.hoisted(() => vi.fn());
vi.mock('../services/piTrackHistory', () => ({ loadPiTrackHistory: load }));
import CurrentHistorySheet from '../components/nmea/CurrentHistorySheet';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const NOW = Date.parse('2026-10-16T10:00:00Z');
beforeEach(() => {
    setAuthIdentityScope('fictional-history-a');
    load.mockReset();
});
afterEach(cleanup);
it('requests only an explicit bounded private window and labels partial/legacy data honestly', async () => {
    load.mockResolvedValue({
        points: [
            {
                at_ms: NOW,
                sog_kts: Math.sqrt(26),
                cog_deg: (Math.atan2(1, 5) * 180) / Math.PI,
                stw_kts: 5,
                sog_at_ms: NOW,
                cog_true_at_ms: NOW,
                stw_at_ms: NOW,
                heading_true_deg: 0,
                heading_true_at_ms: NOW,
            },
            { at_ms: NOW, hdg_deg: 0 },
        ],
        truncated: true,
    });
    render(<CurrentHistorySheet onClose={() => undefined} />);
    await screen.findByText(/1 qualified vectors/);
    expect(screen.getByText(/1 points unavailable/)).toBeVisible();
    expect(screen.getByText(/Partial window/)).toBeVisible();
    expect(screen.getByText(/1.0 kn/)).toBeVisible();
    const options = load.mock.calls[0][0];
    expect(options.maxPoints).toBe(500);
    expect(options.maxPages).toBe(1);
    expect(options.to - options.from).toBe(7200000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.isCurrent()).toBe(true);
});
it('aborts and hides an in-flight private response when the account changes', async () => {
    let resolve!: (value: unknown) => void;
    load.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const close = vi.fn();
    render(<CurrentHistorySheet onClose={close} />);
    const options = load.mock.calls[0][0];
    act(() => setAuthIdentityScope('fictional-history-b'));
    expect(options.signal.aborted).toBe(true);
    expect(options.isCurrent()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    await act(async () => resolve({ points: [], truncated: false }));
    expect(screen.queryByText(/qualified vectors/)).toBeNull();
});
it('shows a transport refusal and never converts it into empty measured current', async () => {
    load.mockRejectedValue(new Error('Paired Pi unavailable'));
    render(<CurrentHistorySheet onClose={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Paired Pi unavailable');
    expect(screen.queryByText(/qualified vectors/)).toBeNull();
});
