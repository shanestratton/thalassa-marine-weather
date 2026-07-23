import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MarineWeatherReport } from '../types';
import { loadWeatherCacheSyncForScope, weatherCacheKeysForScope } from '../services/WeatherOrchestrator';
import { DATA_CACHE_KEY } from '../services/nativeStorage';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

function report(name: string): MarineWeatherReport {
    return {
        locationName: name,
        coordinates: { lat: -27.4, lon: 153.1 },
        generatedAt: new Date().toISOString(),
        current: {},
        hourly: [],
        forecast: [],
        tides: [],
        tideHourly: [],
        alerts: [],
    } as unknown as MarineWeatherReport;
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(null);
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('weather cache identity namespaces', () => {
    it('uses distinct weather/history/voyage/next-update keys for every identity', () => {
        const anonymous = getAuthIdentityScope();
        const anonymousKeys = weatherCacheKeysForScope(anonymous);
        const accountA = setAuthIdentityScope('account-a');
        const accountAKeys = weatherCacheKeysForScope(accountA);
        const accountB = setAuthIdentityScope('account-b');
        const accountBKeys = weatherCacheKeysForScope(accountB);

        expect(new Set([anonymousKeys.data, accountAKeys.data, accountBKeys.data]).size).toBe(3);
        expect(new Set([anonymousKeys.history, accountAKeys.history, accountBKeys.history]).size).toBe(3);
        expect(new Set([anonymousKeys.voyage, accountAKeys.voyage, accountBKeys.voyage]).size).toBe(3);
        expect(new Set([anonymousKeys.nextUpdate, accountAKeys.nextUpdate, accountBKeys.nextUpdate]).size).toBe(3);
    });

    it('never attributes an unscoped legacy report to a signed-in account', () => {
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(report('Unattributed legacy port')));
        const account = setAuthIdentityScope('account-a');

        expect(loadWeatherCacheSyncForScope(account)).toBeNull();
        expect(localStorage.getItem(weatherCacheKeysForScope(account).data)).toBeNull();
    });

    it('preserves legacy first-paint weather only for the public anonymous scope', () => {
        const legacy = report('Anonymous public port');
        localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(legacy));
        const anonymous = getAuthIdentityScope();

        expect(loadWeatherCacheSyncForScope(anonymous)?.locationName).toBe('Anonymous public port');
        // Migration is intentionally deferred until the scoped cache version
        // has been validated; first paint remains instant without resurrecting
        // an incompatible legacy file during a version-clear race.
        expect(localStorage.getItem(weatherCacheKeysForScope(anonymous).data)).toBeNull();
    });

    it('returns only the active account cache when several identities are stored', () => {
        const accountA = setAuthIdentityScope('account-a');
        localStorage.setItem(weatherCacheKeysForScope(accountA).data, JSON.stringify(report('Account A port')));
        const accountB = setAuthIdentityScope('account-b');
        localStorage.setItem(weatherCacheKeysForScope(accountB).data, JSON.stringify(report('Account B port')));

        expect(loadWeatherCacheSyncForScope(accountB)?.locationName).toBe('Account B port');
    });
});
