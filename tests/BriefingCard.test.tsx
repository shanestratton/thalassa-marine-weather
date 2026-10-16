import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ brief: vi.fn(), status: vi.fn() }));
vi.mock('../services/briefing/cachedBriefing', () => ({ cachedBriefing: mocks.brief }));
vi.mock('../services/weatherWatchClient', () => ({ fetchWeatherWatchStatus: mocks.status }));
import BriefingCard from '../components/warnings/BriefingCard';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { pinWeatherBriefing, takeWeatherBriefingPin } from '../services/briefing/briefingPin';
import { composeBriefing } from '../services/briefing/composeBriefing';
const boat = '20000000-0000-4000-8000-000000000001',
    revision = '30000000-0000-4000-8000-000000000001';
beforeEach(() => {
    setAuthIdentityScope('fixture-owner');
    mocks.brief.mockReset();
    mocks.status.mockReset();
    takeWeatherBriefingPin();
});
describe('briefing card source/account/position identity', () => {
    it('shows original run, coarse sampling, unknown tide/datum and explicit model context', async () => {
        const now = Date.now();
        mocks.brief.mockResolvedValue(
            composeBriefing({
                place: 'Public example',
                zone: 'UTC',
                now,
                forecastAt: now - 3_600_000,
                official: { state: 'unavailable' },
                models: ['ECMWF'],
            }),
        );
        render(<BriefingCard point={{ lat: 0, lon: 0 }} place="Public example" />);
        await act(async () => {});
        expect(screen.getByRole('region', { name: 'Weather briefing' })).toHaveTextContent('sampled 0.25° sea cell');
        expect(screen.getByText(/Tide unknown; no clearance judgement/)).toBeInTheDocument();
        expect(screen.getByText(/UKMO counted, never quoted/)).toBeInTheDocument();
    });
    it('does not present another profile or current dashboard position as the tapped registration', async () => {
        pinWeatherBriefing(
            {
                weather_watch: 1,
                feature: 'morning',
                boat_id: boat,
                revision,
                expires: new Date(Date.now() + 600_000).toISOString(),
            },
            getAuthIdentityScope(),
        );
        mocks.status.mockResolvedValue({ profile: { revision: '30000000-0000-4000-8000-000000000002' } });
        render(<BriefingCard acceptPush point={{ lat: 10, lon: 20 }} />);
        await act(async () => {});
        expect(screen.getByRole('status')).toHaveTextContent('registration changed');
        expect(mocks.brief).not.toHaveBeenCalled();
    });
    it('discards a late account-A private result after switching', async () => {
        let finish!: (v: unknown) => void;
        mocks.brief.mockReturnValue(
            new Promise((r) => {
                finish = r;
            }),
        );
        render(<BriefingCard point={{ lat: 0, lon: 0 }} />);
        await act(async () => {});
        act(() => setAuthIdentityScope(null));
        await act(async () => {
            finish(null);
        });
        expect(screen.queryByRole('region', { name: 'Weather briefing' })).toBeNull();
    });
});
