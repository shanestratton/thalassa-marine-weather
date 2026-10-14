/**
 * Signed out, the app never asks the official-warnings and status RPCs: they
 * are for signed-in users, and asking logged a 404 before 129's migrations and
 * a 401 after them (release run 38517476280, Anchor Watch e2e). The page keeps
 * today's position-aware links instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn(async (_name: string, _args?: unknown) => ({ data: null, error: null })));
vi.mock('../services/supabase', () => ({ supabase: { rpc } }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { clearOfficialWarningsCache, fetchOfficialWarnings } from '../services/officialWarnings';
import { fetchCycloneWatchStatus } from '../services/cycloneWatchStatus';
import { fetchWeatherAlertStatus } from '../services/weatherAlertStatus';
import { fetchOfficialAlertsWatchStatus } from '../services/officialAlertsWatchStatus';

beforeEach(() => {
    rpc.mockClear();
    clearOfficialWarningsCache();
});
afterEach(() => setAuthIdentityScope(null));

describe('signed out: no official or status RPC is asked', () => {
    it('official warnings, the cyclone watch, forecast alerts and the warnings watch', async () => {
        setAuthIdentityScope(null);
        expect(await fetchOfficialWarnings(39.1, -76.4)).toBeNull();
        expect(await fetchCycloneWatchStatus()).toBeNull();
        expect(await fetchWeatherAlertStatus()).toBeNull();
        expect(await fetchOfficialAlertsWatchStatus()).toBeNull();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('signed in, each one is asked', async () => {
        setAuthIdentityScope('fixture-skipper');
        await fetchOfficialWarnings(39.1, -76.4);
        await fetchCycloneWatchStatus();
        await fetchWeatherAlertStatus();
        await fetchOfficialAlertsWatchStatus();
        expect(rpc.mock.calls.map((c) => c[0])).toEqual([
            'official_alerts_at',
            'cyclone_watch_status',
            'weather_alert_status',
            'official_alerts_watch_status',
        ]);
    });
});
