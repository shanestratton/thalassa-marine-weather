import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyagePlan } from '../types';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const weatherMocks = vi.hoisted(() => ({
    enhanceVoyagePlanWithWeather: vi.fn(),
}));

vi.mock('../services/weatherRouter', () => ({
    enhanceVoyagePlanWithWeather: weatherMocks.enhanceVoyagePlanWithWeather,
}));

import { useFollowRouteStore } from '../stores/followRouteStore';
import { useSettingsStore } from '../stores/settingsStore';
import { PassageStore } from '../stores/PassageStore';
import { clearPassageRequest, peekPassageRequest, requestPassageMode } from '../services/passageHandoff';

function plan(name: string): VoyagePlan {
    return {
        origin: `${name} origin`,
        destination: `${name} destination`,
        departureDate: '2026-08-01T00:00:00.000Z',
        originCoordinates: { lat: -27.47, lon: 153.03 },
        destinationCoordinates: { lat: -22.27, lon: 166.44 },
        distanceApprox: '800 NM',
        durationApprox: '4 days',
        overview: name,
        waypoints: [],
    };
}

describe('navigation singleton identity isolation', () => {
    beforeEach(() => {
        localStorage.clear();
        for (const identity of [null, 'account-a', 'account-b']) {
            setAuthIdentityScope(identity);
            clearPassageRequest();
        }
        setAuthIdentityScope(null);
        useFollowRouteStore.getState().stopFollowing();
        PassageStore.clear();
        weatherMocks.enhanceVoyagePlanWithWeather.mockReset();
    });

    it('keeps followed routes and passage drafts scoped to their account and ignores legacy state', () => {
        localStorage.setItem(
            'thalassa_follow_route',
            JSON.stringify({
                isFollowing: true,
                voyagePlan: plan('legacy'),
                voyageId: 'legacy-voyage',
                startedAt: new Date().toISOString(),
            }),
        );
        localStorage.setItem(
            'thalassa_passage_route',
            JSON.stringify({ hasRoute: true, routeName: 'legacy secret route' }),
        );

        const accountA = setAuthIdentityScope('account-a');
        expect(useFollowRouteStore.getState().isFollowing).toBe(false);
        expect(PassageStore.getState().hasRoute).toBe(false);

        useFollowRouteStore.getState().startFollowing(plan('account A'), 'voyage-a');
        PassageStore.setFromRoute({ routeName: 'A draft', departPort: 'Brisbane', destPort: 'Noumea' });

        expect(localStorage.getItem(authScopedStorageKey('thalassa_follow_route', accountA))).toContain('voyage-a');
        expect(localStorage.getItem(authScopedStorageKey('thalassa_passage_route', accountA))).toContain('A draft');

        const accountB = setAuthIdentityScope('account-b');
        expect(useFollowRouteStore.getState().isFollowing).toBe(false);
        expect(useFollowRouteStore.getState().voyageId).toBeNull();
        expect(PassageStore.getState().hasRoute).toBe(false);
        expect(PassageStore.getState().routeName).toBeNull();

        useFollowRouteStore.getState().startFollowing(plan('account B'), 'voyage-b');
        PassageStore.setFromRoute({ routeName: 'B draft', departPort: 'Cairns', destPort: 'Darwin' });
        expect(localStorage.getItem(authScopedStorageKey('thalassa_follow_route', accountB))).toContain('voyage-b');

        setAuthIdentityScope('account-a');
        expect(useFollowRouteStore.getState().voyageId).toBe('voyage-a');
        expect(useFollowRouteStore.getState().voyagePlan?.overview).toBe('account A');
        expect(PassageStore.getState().routeName).toBe('A draft');

        setAuthIdentityScope('account-b');
        expect(useFollowRouteStore.getState().voyageId).toBe('voyage-b');
        expect(PassageStore.getState().routeName).toBe('B draft');
    });

    it('drops a weather refresh that resolves after the account changes', async () => {
        setAuthIdentityScope('account-a');
        useSettingsStore.setState((state) => ({
            settings: {
                ...state.settings,
                vessel: {
                    name: 'A boat',
                    type: 'sail',
                    length: 10,
                    beam: 3.2,
                    draft: 1.6,
                    displacement: 5_000,
                    maxWaveHeight: 4,
                    cruisingSpeed: 6,
                },
            },
        }));
        useFollowRouteStore.getState().startFollowing(plan('account A original'), 'voyage-a');

        let resolveWeather!: (updated: VoyagePlan) => void;
        weatherMocks.enhanceVoyagePlanWithWeather.mockReturnValue(
            new Promise<VoyagePlan>((resolve) => {
                resolveWeather = resolve;
            }),
        );

        const pendingRefresh = useFollowRouteStore.getState().refreshRoute();
        await vi.waitFor(() => expect(weatherMocks.enhanceVoyagePlanWithWeather).toHaveBeenCalledTimes(1));

        setAuthIdentityScope('account-b');
        useFollowRouteStore.getState().startFollowing(plan('account B current'), 'voyage-b');
        resolveWeather(plan('late account A result'));
        await pendingRefresh;

        expect(useFollowRouteStore.getState().voyageId).toBe('voyage-b');
        expect(useFollowRouteStore.getState().voyagePlan?.overview).toBe('account B current');

        setAuthIdentityScope('account-a');
        expect(useFollowRouteStore.getState().voyagePlan?.overview).toBe('account A original');
    });

    it('rejects an explicitly fenced passage-store callback from an old account', () => {
        const accountA = setAuthIdentityScope('account-a');
        PassageStore.setFromRoute({ routeName: 'A draft' }, accountA);

        setAuthIdentityScope('account-b');
        PassageStore.setFromRoute({ routeName: 'late A result' }, accountA);
        PassageStore.clear(accountA);

        expect(getAuthIdentityScope().userId).toBe('account-b');
        expect(PassageStore.getState().hasRoute).toBe(false);
        expect(PassageStore.getState().routeName).toBeNull();
    });

    it('scopes sticky passage handoffs and rejects delayed requests from the previous account', () => {
        const accountA = setAuthIdentityScope('account-a');
        requestPassageMode({ departure: { lat: -27.47, lon: 153.03, name: 'A departure' } }, accountA);
        expect(peekPassageRequest()?.departure?.name).toBe('A departure');

        setAuthIdentityScope('account-b');
        expect(peekPassageRequest()).toBeNull();
        requestPassageMode({ departure: { lat: -16.92, lon: 145.78, name: 'B departure' } });

        requestPassageMode({ arrival: { lat: -22.27, lon: 166.44, name: 'Late A arrival' } }, accountA);
        expect(peekPassageRequest()?.departure?.name).toBe('B departure');
        expect(peekPassageRequest()?.arrival).toBeUndefined();

        setAuthIdentityScope('account-a');
        expect(peekPassageRequest()?.departure?.name).toBe('A departure');
    });
});
