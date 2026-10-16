import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { declareEngineRunning, endEngineRunCounter, newEngineRunCounter } from '../services/shiplog/engineRunCounter';
import type { EngineHoursOffer } from '../services/shiplog/engineHoursOffer';

const api = vi.hoisted(() => ({ load: vi.fn(), confirm: vi.fn() }));
vi.mock('../services/shiplog/engineHoursReview', () => ({
    loadEngineHoursReview: api.load,
    confirmEngineHours: api.confirm,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (select: (s: unknown) => unknown) =>
        select({ vesselFleet: [{ id: 'boat-a', profile: { name: 'Example Boat' } }] }),
}));
import EngineHoursReviewSheet from '../components/vessel/EngineHoursReviewSheet';
import { GlobalEngineHoursReviewGate } from '../components/vessel/GlobalEngineHoursReviewGate';
import { requestEngineHoursReview } from '../services/shiplog/engineHoursOffer';
const T = 1_800_000_000_000;
function offer(id = 'voyage_one'): EngineHoursOffer {
    return {
        scope: setAuthIdentityScope('owner-a'),
        boatId: 'boat-a',
        counter: endEngineRunCounter(declareEngineRunning(newEngineRunCounter(id, T), true, T), T + 3_600_000),
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    api.load.mockResolvedValue({ hours: 100, alreadyConfirmed: false });
    api.confirm.mockResolvedValue({ applied: true, hours: 101, remainderSeconds: 0 });
});
afterEach(() => cleanup());
describe('voyage engine review sheet', () => {
    it('requires the boat/meter check before a single explicit addition', async () => {
        const candidate = offer();
        render(<EngineHoursReviewSheet offer={candidate} onClose={() => undefined} />);
        expect(screen.getByRole('button', { name: 'Add recorded time' })).toBeDisabled();
        expect(await screen.findByText(/Current Maintenance reading: 100 h/)).toBeInTheDocument();
        expect(screen.getByText('Voyage boat: Example Boat.')).toBeInTheDocument();
        expect(api.confirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Add recorded time' }));
        expect(await screen.findByText('Confirmed. Maintenance reads 101 h.')).toBeInTheDocument();
        expect(api.confirm).toHaveBeenCalledTimes(1);
        expect(api.confirm.mock.calls[0][0]).toBe(candidate);
        expect(api.confirm.mock.calls[0][1]).toBe(100);
    });
    it('does not show a late old voyage reading on a new same-account offer', async () => {
        let finish!: (v: unknown) => void;
        api.load.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
        const a = offer('voyage_a'),
            b = offer('voyage_b');
        const ui = render(<EngineHoursReviewSheet offer={a} onClose={() => undefined} />);
        ui.rerender(<EngineHoursReviewSheet offer={b} onClose={() => undefined} />);
        await screen.findByText(/Current Maintenance reading: 100 h/);
        await act(async () => finish({ hours: 999, alreadyConfirmed: false }));
        expect(screen.queryByText(/Current Maintenance reading: 999 h/)).not.toBeInTheDocument();
    });
    it('keeps already confirmed and clock-uncertain records out of the add path', async () => {
        const candidate = offer();
        api.load.mockResolvedValue({ hours: 100, alreadyConfirmed: true });
        const ui = render(<EngineHoursReviewSheet offer={candidate} onClose={() => undefined} />);
        await screen.findByText('This voyage’s engine time was already counted.');
        expect(screen.getByRole('button', { name: 'Add recorded time' })).toBeDisabled();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        api.load.mockResolvedValue({ hours: 100, alreadyConfirmed: false });
        ui.rerender(
            <EngineHoursReviewSheet
                offer={{ ...candidate, counter: { ...candidate.counter, clockUncertain: true } }}
                onClose={() => undefined}
            />,
        );
        await screen.findByText(/clock changed/i);
        expect(screen.getByRole('button', { name: 'Add recorded time' })).toBeDisabled();
        expect(api.confirm).not.toHaveBeenCalled();
    });
    it('retires the mounted account’s private review immediately on account change', async () => {
        const candidate = offer();
        render(<GlobalEngineHoursReviewGate />);
        act(() => requestEngineHoursReview(candidate.counter, candidate.boatId));
        await screen.findByText(/Current Maintenance reading: 100 h/);
        act(() => {
            setAuthIdentityScope('owner-b');
        });
        await waitFor(() => expect(screen.queryByText(/Current Maintenance reading/)).not.toBeInTheDocument());
        expect(api.confirm).not.toHaveBeenCalled();
    });
});
