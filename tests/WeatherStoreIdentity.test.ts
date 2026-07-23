import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MarineWeatherReport, VoyagePlan } from '../types';
import { useWeatherStore } from '../stores/weatherStore';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const accountAWeather = { locationName: 'Private A port' } as MarineWeatherReport;
const accountAVoyage = { name: 'Private A voyage' } as unknown as VoyagePlan;

beforeEach(() => {
    setAuthIdentityScope('account-a');
    const scope = getAuthIdentityScope();
    useWeatherStore.getState()._sync(
        {
            weatherData: accountAWeather,
            voyagePlan: accountAVoyage,
            loading: false,
            backgroundUpdating: true,
            staleRefresh: true,
            error: 'Private A error',
            nextUpdate: 12345,
            historyCache: { 'Private A port': accountAWeather },
        },
        scope,
    );
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('weatherStore identity bridge', () => {
    it('blanks every account-bearing slice synchronously on A → B', () => {
        const scopeB = setAuthIdentityScope('account-b');
        const state = useWeatherStore.getState();

        expect(state).toMatchObject({
            identityKey: scopeB.key,
            identityGeneration: scopeB.generation,
            weatherData: null,
            voyagePlan: null,
            loading: true,
            loadingMessage: 'Initializing Weather Data...',
            error: null,
            quotaUsed: 0,
            backgroundUpdating: false,
            staleRefresh: false,
            nextUpdate: null,
            historyCache: {},
        });
    });

    it('rejects a late context bridge write captured under account A', () => {
        const scopeA = getAuthIdentityScope();
        setAuthIdentityScope('account-b');

        useWeatherStore.getState()._sync(
            {
                weatherData: accountAWeather,
                voyagePlan: accountAVoyage,
                loading: false,
                historyCache: { leaked: accountAWeather },
            },
            scopeA,
        );

        expect(useWeatherStore.getState()).toMatchObject({
            weatherData: null,
            voyagePlan: null,
            loading: true,
            historyCache: {},
        });
    });

    it('accepts the new account bridge after the synchronous blank', () => {
        const scopeB = setAuthIdentityScope('account-b');
        const accountBWeather = { locationName: 'Account B port' } as MarineWeatherReport;

        useWeatherStore.getState()._sync({ weatherData: accountBWeather, loading: false }, scopeB);

        expect(useWeatherStore.getState()).toMatchObject({
            weatherData: accountBWeather,
            loading: false,
        });
    });

    it('uses generation as well as user id when the same account signs in again', () => {
        const firstLogin = getAuthIdentityScope();
        setAuthIdentityScope(null);
        const secondLogin = setAuthIdentityScope('account-a');

        useWeatherStore.getState()._sync({ weatherData: accountAWeather, loading: false }, firstLogin);

        expect(secondLogin.key).toBe(firstLogin.key);
        expect(secondLogin.generation).not.toBe(firstLogin.generation);
        expect(useWeatherStore.getState().weatherData).toBeNull();
        expect(useWeatherStore.getState().loading).toBe(true);
    });
});
