import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passageHudLayerSources, usePassageHudLayerActivation } from '../components/map/passageHudLayer';
import {
    __resetPassageHudForTests,
    activatePassageHudForRecording,
    getPassageLookAhead,
    isPassageHudEnabled,
    isPassageHudOpen,
    setPassageHudEnabled,
    setPassageHudOpen,
    startPassageLookAhead,
    usePassageHudEnabled,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn } from '../stores/chartPassageOverlay';

const policy = vi.hoisted(() => ({ blocked: false }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => policy.blocked }));

const coords = [
    { lat: -27, lon: 153 },
    { lat: -26, lon: 154 },
];
function deps(overrides: Partial<Parameters<typeof passageHudLayerSources>[0]> = {}) {
    return {
        isFollowing: true,
        routeCoords: coords,
        enabled: isPassageHudEnabled(),
        weather: { setLayerVisibility: vi.fn() },
        setWeatherInspectMode: vi.fn(),
        closeWeatherInspect: vi.fn(),
        setLightningVisible: vi.fn(),
        setCycloneVisible: vi.fn(),
        setSquallVisible: vi.fn(),
        setAisVisible: vi.fn(),
        ...overrides,
    };
}

function mountLayer(controls = deps()) {
    return renderHook(() => {
        const enabled = usePassageHudEnabled();
        const args = { ...controls, enabled };
        usePassageHudLayerActivation(args);
        return passageHudLayerSources(args);
    });
}

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    setPassageHudEnabled(false);
    policy.blocked = false;
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
});
afterEach(() => {
    setPassageHudEnabled(false);
    vi.unstubAllEnvs();
});

describe('Passage HUD in the OBS layer FAB', () => {
    it('only offers the HUD for an actively followed route with usable geometry', () => {
        expect(passageHudLayerSources(deps({ isFollowing: false }))).toEqual([]);
        expect(passageHudLayerSources(deps({ routeCoords: [] }))).toEqual([]);
        expect(passageHudLayerSources(deps({ routeCoords: coords.slice(0, 1) }))).toEqual([]);
        expect(passageHudLayerSources(deps())).toEqual([
            expect.objectContaining({ id: 'passage-hud', label: 'Passage HUD', enabled: false }),
        ]);
    });

    it('opens HUD and passage overlays, leaves Inspect, and requests real weather layers through their setters', () => {
        const controls = deps();
        const layer = mountLayer(controls);
        act(() => layer.result.current[0].onToggle());
        expect(isPassageHudEnabled()).toBe(true);
        expect(isPassageHudOpen()).toBe(true);
        expect(isPassageOverlayOn()).toBe(true);
        expect(controls.setWeatherInspectMode).toHaveBeenCalledWith(false);
        expect(controls.closeWeatherInspect).toHaveBeenCalledOnce();
        expect(controls.setLightningVisible).toHaveBeenCalledWith(false);
        expect(controls.setCycloneVisible).toHaveBeenCalledWith(false);
        expect(controls.setAisVisible).toHaveBeenCalledExactlyOnceWith(true);
        expect(vi.mocked(controls.weather.setLayerVisibility).mock.calls).toEqual([
            ['wind', true],
            ['rain', true],
        ]);
        expect(controls.setSquallVisible).toHaveBeenCalledWith(true);
    });

    it('does not request raster overlays on a satellite-restricted connection', () => {
        policy.blocked = true;
        const controls = deps();
        const layer = mountLayer(controls);
        act(() => layer.result.current[0].onToggle());
        expect(vi.mocked(controls.weather.setLayerVisibility).mock.calls).toEqual([['wind', true]]);
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
        expect(isPassageHudOpen()).toBe(true);
    });

    it('offers and activates instruments, AIS and weather for a route-free recording', () => {
        const controls = deps({ isFollowing: false, routeCoords: [], hasRecording: true });
        const layer = mountLayer(controls);
        act(() => layer.result.current[0].onToggle());
        expect(isPassageHudEnabled()).toBe(true);
        expect(isPassageHudOpen()).toBe(true);
        expect(isPassageOverlayOn()).toBe(true);
        expect(controls.setAisVisible).toHaveBeenCalledExactlyOnceWith(true);
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('wind', true);
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('rain', true);
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalledWith('pressure', true);
    });

    it('does not reapply layer choices when the chart temporarily stands down', () => {
        setPassageHudEnabled(true);
        const controls = deps({ hasRecording: true });
        const layer = renderHook(({ visible }) => usePassageHudLayerActivation({ ...controls, enabled: visible }), {
            initialProps: { visible: true },
        });
        vi.mocked(controls.setAisVisible).mockClear();
        vi.mocked(controls.weather.setLayerVisibility).mockClear();
        layer.rerender({ visible: false });
        layer.rerender({ visible: true });
        expect(controls.setAisVisible).not.toHaveBeenCalled();
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
    });

    it('applies layers once for each new recording even when the HUD is already on', () => {
        const controls = deps({ isFollowing: false, routeCoords: [], hasRecording: true });
        mountLayer(controls);
        act(() => activatePassageHudForRecording('recording-a'));
        expect(controls.setAisVisible).toHaveBeenCalledTimes(1);
        act(() => activatePassageHudForRecording('recording-a'));
        expect(controls.setAisVisible).toHaveBeenCalledTimes(1);
        act(() => activatePassageHudForRecording('recording-b'));
        expect(controls.setAisVisible).toHaveBeenCalledTimes(2);
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalledWith('pressure', true);
    });

    it('can request public radar without pretending the unconfigured squall service exists', () => {
        vi.stubEnv('VITE_SUPABASE_URL', '');
        const controls = deps();
        const layer = mountLayer(controls);
        act(() => layer.result.current[0].onToggle());
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('rain', true);
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
    });

    it('switches HUD and forecast off without toggling the selected weather layers', () => {
        const controls = deps();
        const layer = mountLayer(controls);
        act(() => layer.result.current[0].onToggle());
        startPassageLookAhead();
        vi.mocked(controls.weather.setLayerVisibility).mockClear();
        vi.mocked(controls.setSquallVisible).mockClear();
        const [entry] = layer.result.current;
        expect(entry.enabled).toBe(true);
        act(() => entry.onToggle());
        expect(isPassageHudEnabled()).toBe(false);
        expect(isPassageHudOpen()).toBe(false);
        expect(getPassageLookAhead().on).toBe(false);
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
    });

    it('restores enabled HUD activation once, keeps collapse state, and respects later weather choices', () => {
        setPassageHudEnabled(true);
        setPassageHudOpen(false);
        const controls = deps();
        const layer = mountLayer(controls);
        expect(controls.setWeatherInspectMode).toHaveBeenCalledExactlyOnceWith(false);
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('wind', true);
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('rain', true);
        expect(controls.setSquallVisible).toHaveBeenCalledExactlyOnceWith(true);
        expect(isPassageOverlayOn()).toBe(true);
        expect(isPassageHudOpen()).toBe(false);

        vi.mocked(controls.weather.setLayerVisibility).mockClear();
        vi.mocked(controls.setSquallVisible).mockClear();
        layer.rerender();
        act(() => setPassageHudOpen(true));
        layer.rerender();
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
        expect(controls.setSquallVisible).not.toHaveBeenCalled();

        act(() => layer.result.current[0].onToggle());
        act(() => layer.result.current[0].onToggle());
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('wind', true);
        expect(controls.setSquallVisible).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('never restores HUD weather for a missing followed route', () => {
        setPassageHudEnabled(true);
        const controls = deps({ isFollowing: false });
        const layer = mountLayer(controls);
        expect(layer.result.current).toEqual([]);
        expect(controls.setWeatherInspectMode).not.toHaveBeenCalled();
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
        expect(isPassageOverlayOn()).toBe(false);
    });

    it('is wired to follow state in the layer FAB and has no Settings activation', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('...passageHudLayerSources({');
        expect(hub).toContain('usePassageHudLayerActivation({');
        expect(hub).toContain('isFollowing: isFollowingRoute');
        expect(hub).toContain('routeCoords: followedRouteCoords');
        expect(hub).toContain('if (planningSurface || passageHudOnChart) return;');
        const preferences = readFileSync('components/settings/GeneralTab.tsx', 'utf8');
        expect(preferences).not.toContain('PassageStripSection');
        expect(preferences).not.toContain('setPassageHudEnabled');
    });
});
