import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePassageHudLayerActivation } from '../components/map/passageHudLayer';
import {
    __resetPassageHudForTests,
    activatePassageHudForRecording,
    isPassageHudOpen,
    setPassageHudOpen,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn, setPassageOverlay } from '../stores/chartPassageOverlay';

const policy = vi.hoisted(() => ({ blocked: false }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => policy.blocked }));

function deps(overrides: Partial<Parameters<typeof usePassageHudLayerActivation>[0]> = {}) {
    return {
        available: true,
        recording: true,
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
    return renderHook(
        ({ available, recording }: { available: boolean; recording: boolean }) =>
            usePassageHudLayerActivation({ ...controls, available, recording }),
        { initialProps: { available: controls.available, recording: controls.recording } },
    );
}

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    policy.blocked = false;
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
});
afterEach(() => {
    vi.unstubAllEnvs();
});

describe('the HUD’s first weather layers (no switch, build 124)', () => {
    it('being on the chart is not an activation: a launch with a followed route or a preview opens no layer', () => {
        const controls = deps();
        const layer = mountLayer(controls);
        layer.rerender({ available: false, recording: false });
        layer.rerender({ available: true, recording: false });
        expect(controls.setWeatherInspectMode).not.toHaveBeenCalled();
        expect(controls.setAisVisible).not.toHaveBeenCalled();
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
        expect(isPassageOverlayOn()).toBe(false);
    });

    it('a recording starting opens the passage, leaves Inspect and requests real weather layers through their setters', () => {
        const controls = deps();
        mountLayer(controls);
        act(() => activatePassageHudForRecording('rec-north-sea'));
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
        mountLayer(controls);
        act(() => activatePassageHudForRecording('rec-offshore'));
        expect(vi.mocked(controls.weather.setLayerVisibility).mock.calls).toEqual([['wind', true]]);
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
        expect(isPassageHudOpen()).toBe(true);
    });

    it('a recording started in Log is applied once when the chart first shows the HUD', () => {
        act(() => activatePassageHudForRecording('rec-started-in-log'));
        const controls = deps({ available: false });
        const layer = mountLayer(controls);
        expect(controls.setAisVisible).not.toHaveBeenCalled();
        layer.rerender({ available: true, recording: true });
        expect(controls.setAisVisible).toHaveBeenCalledExactlyOnceWith(true);
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('wind', true);
    });

    it('does not reapply layer choices when the chart temporarily stands down', () => {
        const controls = deps();
        const layer = mountLayer(controls);
        act(() => activatePassageHudForRecording('rec-a'));
        vi.mocked(controls.setAisVisible).mockClear();
        vi.mocked(controls.weather.setLayerVisibility).mockClear();
        layer.rerender({ available: false, recording: true });
        layer.rerender({ available: true, recording: true });
        expect(controls.setAisVisible).not.toHaveBeenCalled();
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
    });

    it('a recording’s activation never replays for a route pulled up later with no recording on the chart', () => {
        // Review (build 124 HS): the chart mounts only when Obs is first opened.
        // A recording started and stopped from Log left its activation unapplied;
        // the first route then pulled up on Obs made the HUD available and
        // replayed that old recording's weather set-up. Being on the chart for a
        // followed route or a preview is not a recording.
        act(() => activatePassageHudForRecording('rec-started-and-stopped-in-log'));
        act(() => setPassageOverlay(false));
        const controls = deps({ available: false, recording: false });
        const layer = mountLayer(controls);
        layer.rerender({ available: true, recording: false });
        expect(controls.setWeatherInspectMode).not.toHaveBeenCalled();
        expect(controls.closeWeatherInspect).not.toHaveBeenCalled();
        expect(controls.setAisVisible).not.toHaveBeenCalled();
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalled();
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
        expect(isPassageOverlayOn()).toBe(false);
    });

    it('applies layers once for each new recording, and respects the skipper’s collapse', () => {
        const controls = deps();
        mountLayer(controls);
        act(() => activatePassageHudForRecording('recording-a'));
        expect(controls.setAisVisible).toHaveBeenCalledTimes(1);
        act(() => setPassageHudOpen(false));
        act(() => activatePassageHudForRecording('recording-a'));
        expect(controls.setAisVisible).toHaveBeenCalledTimes(1);
        expect(isPassageHudOpen()).toBe(false);
        act(() => activatePassageHudForRecording('recording-b'));
        expect(controls.setAisVisible).toHaveBeenCalledTimes(2);
        expect(controls.weather.setLayerVisibility).not.toHaveBeenCalledWith('pressure', true);
    });

    it('can request public radar without pretending the unconfigured squall service exists', () => {
        vi.stubEnv('VITE_SUPABASE_URL', '');
        const controls = deps();
        mountLayer(controls);
        act(() => activatePassageHudForRecording('rec-radar'));
        expect(controls.weather.setLayerVisibility).toHaveBeenCalledWith('rain', true);
        expect(controls.setSquallVisible).not.toHaveBeenCalled();
    });

    it('is wired to the HUD on the chart, and the layer framing stands down while it is there', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('usePassageHudLayerActivation({');
        expect(hub).toContain('available: passageHudOnChart,');
        expect(hub).toContain('recording: hasRecording,');
        expect(hub).toContain('useLayerFrameSnap(mapRef, weather.userLayers, planningSurface || passageHudOnChart)');
        const preferences = readFileSync('components/settings/GeneralTab.tsx', 'utf8');
        expect(preferences).not.toContain('PassageStripSection');
    });
});
