import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyagePlan } from '../types';
const bridge = vi.hoisted(() => ({ clear: vi.fn(), toast: vi.fn() }));
vi.mock('../services/piCourse', () => ({ clearUnfollowedCourse: bridge.clear }));
vi.mock('../components/Toast', () => ({ toast: { persistentError: bridge.toast } }));
import { useFollowRouteStore } from '../stores/followRouteStore';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
const plan = { origin: 'Fictional A', destination: 'Fictional B', waypoints: [] } as unknown as VoyagePlan;
const points = [
    { lat: 30, lon: 179.9 },
    { lat: 30.1, lon: -179.8 },
];
const settled = () => vi.dynamicImportSettled();
beforeEach(async () => {
    setAuthIdentityScope(null);
    localStorage.clear();
    useFollowRouteStore.getState().stopFollowing();
    await settled();
    bridge.clear.mockReset().mockResolvedValue(undefined);
    bridge.toast.mockReset();
    setAuthIdentityScope('fictional-owner-a');
});
afterEach(() => {
    setAuthIdentityScope(null);
});
describe('real Follow store course lifecycle', () => {
    it('unfollow clears the captured old route under the original account after the state is reset', async () => {
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-a', points);
        const original = useFollowRouteStore.getState(),
            scope = getAuthIdentityScope();
        useFollowRouteStore.getState().stopFollowing();
        await settled();
        expect(useFollowRouteStore.getState().isFollowing).toBe(false);
        expect(bridge.clear).toHaveBeenCalledExactlyOnceWith(original, scope);
    });
    it('an account fence cannot clear the old account’s boat with the new account’s receipt', async () => {
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-a', points);
        setAuthIdentityScope('fictional-owner-b');
        await settled();
        expect(bridge.clear).not.toHaveBeenCalled();
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-b', points);
        useFollowRouteStore.getState().stopFollowing();
        await settled();
        expect(bridge.clear).toHaveBeenCalledTimes(1);
        expect(bridge.clear.mock.calls[0][1].userId).toBe('fictional-owner-b');
    });
    it('actual geometry replacement clears its earlier send; equal coordinates and weather refreshes do not', async () => {
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-a', points);
        useFollowRouteStore.setState({
            routeCoords: points.map((p) => ({ ...p })),
            lastRefresh: new Date().toISOString(),
        });
        await settled();
        expect(bridge.clear).not.toHaveBeenCalled();
        const old = useFollowRouteStore.getState();
        useFollowRouteStore.setState({ routeCoords: [{ ...points[0] }, { lat: 30.2, lon: -179.7 }] });
        await settled();
        expect(bridge.clear).toHaveBeenCalledTimes(1);
        expect(bridge.clear.mock.calls[0][0]).toEqual(old);
        expect(bridge.clear.mock.calls[0][0].routeCoords).not.toBe(old.routeCoords);
    });
    it('a failed clear reports an unconfirmed plotter only while its owning identity is still current', async () => {
        bridge.clear.mockRejectedValueOnce(Error('Offline'));
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-a', points);
        useFollowRouteStore.getState().stopFollowing();
        await settled();
        expect(bridge.toast).toHaveBeenCalledWith(expect.stringMatching(/plotter clear is unconfirmed/));
        bridge.toast.mockClear();
        bridge.clear.mockRejectedValueOnce(Error('Offline'));
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-a', points);
        useFollowRouteStore.getState().stopFollowing();
        setAuthIdentityScope('fictional-owner-b');
        await settled();
        expect(bridge.toast).not.toHaveBeenCalled();
    });
    it('captures immutable old coordinates before the lazy clear module can finish loading', async () => {
        useFollowRouteStore.getState().startFollowing(plan, 'voyage-a', points);
        const old = useFollowRouteStore.getState(),
            expected = old.routeCoords.map((point) => ({ ...point }));
        useFollowRouteStore.getState().stopFollowing();
        old.routeCoords[0].lat = 33;
        await settled();
        expect(bridge.clear.mock.calls[0][0].routeCoords).toEqual(expected);
    });
});
