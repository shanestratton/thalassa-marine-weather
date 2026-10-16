import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    save: vi.fn(),
    state: {
        activeVesselId: '20000000-0000-4000-8000-000000000001',
        settings: { savedLocations: ['Example spot'], savedLocationCoords: { 'Example spot': { lat: 0, lon: 0 } } },
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign((select: (s: typeof mocks.state) => unknown) => select(mocks.state), {
        getState: () => mocks.state,
    }),
}));
vi.mock('../services/weatherWatchClient', () => ({
    fetchWeatherWatchStatus: mocks.fetch,
    saveWeatherWatch: mocks.save,
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
import WeatherWatchSection from '../components/settings/WeatherWatchSection';
import { defaultWeatherWatch } from '../utils/weatherWatch';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const revision = '30000000-0000-4000-8000-000000000001';
const status = () => {
    const cap = {
        functionVersion: 1,
        deliveryVersion: 1,
        scheduled: true,
        entitlementUntil: Date.now() + 3_600_000,
        succeededAt: Date.now(),
    };
    return {
        profile: { revision, preferences: defaultWeatherWatch() },
        capabilities: { morning: cap, rain: cap, storm: cap, gust: cap },
    };
};
beforeEach(() => {
    setAuthIdentityScope('fixture-owner');
    mocks.fetch.mockReset();
    mocks.save.mockReset();
    mocks.state.activeVesselId = '20000000-0000-4000-8000-000000000001';
    mocks.save.mockResolvedValue(revision);
});
afterEach(() => vi.useRealTimers());
describe('capability-gated explicit weather opt-ins', () => {
    it('offers no opt-ins for missing, unscheduled, stale or unentitled capability', async () => {
        const s = status();
        for (const cap of Object.values(s.capabilities)) cap.deliveryVersion = 0;
        mocks.fetch.mockResolvedValue(s);
        const view = render(<WeatherWatchSection />);
        await act(async () => {});
        expect(screen.queryByRole('switch')).toBeNull();
        view.unmount();
        mocks.fetch.mockResolvedValue(null);
        render(<WeatherWatchSection />);
        await act(async () => {});
        expect(screen.queryByRole('switch')).toBeNull();
    });
    it('starts off, requires explicit Save, and sends only the chosen saved point', async () => {
        mocks.fetch.mockResolvedValue(status());
        render(<WeatherWatchSection />);
        await act(async () => {});
        expect(screen.getAllByRole('switch')).toHaveLength(4);
        for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(screen.getByRole('switch', { name: 'Route and spot thunder risk' }));
        expect(mocks.save).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole('combobox', { name: 'Add a saved spot' }), {
            target: { value: 'Example spot' },
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save forecast watch' }));
        });
        expect(mocks.save).toHaveBeenCalledTimes(1);
        expect(mocks.save.mock.calls[0][2]).toMatchObject({
            morning: false,
            rain: false,
            storm: true,
            samples: [{ kind: 'spot', label: 'Example spot', lat: 0, lon: 0 }],
        });
    });
    it('a background capability poll never upgrades the reviewed CAS revision under an unsaved draft', async () => {
        vi.useFakeTimers();
        const initial = status();
        mocks.fetch.mockResolvedValue(initial);
        render(<WeatherWatchSection />);
        await act(async () => {});
        fireEvent.click(screen.getByRole('switch', { name: 'Morning briefing' }));
        mocks.fetch.mockResolvedValue({
            ...status(),
            profile: {
                revision: '30000000-0000-4000-8000-000000000002',
                preferences: { ...defaultWeatherWatch(), rain: true },
            },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save forecast watch' }));
        });
        expect(mocks.save.mock.calls[0][1]).toBe(revision);
        expect(mocks.save.mock.calls[0][2]).toMatchObject({ morning: true, rain: false });
    });
    it('hides account-A state immediately and discards a late save result after switching accounts', async () => {
        mocks.fetch.mockResolvedValue(status());
        render(<WeatherWatchSection />);
        await act(async () => {});
        let finish!: (v: string) => void;
        mocks.save.mockReturnValue(
            new Promise((r) => {
                finish = r;
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save forecast watch' }));
        for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled();
        mocks.fetch.mockResolvedValue(null);
        act(() => setAuthIdentityScope('different-owner'));
        await act(async () => {
            finish(revision);
        });
        expect(screen.queryByRole('switch')).toBeNull();
        expect(screen.queryByText('Saved for this vessel.')).toBeNull();
    });
});
