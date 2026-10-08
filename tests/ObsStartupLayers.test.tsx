import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { readFileSync } from 'node:fs';
import { useMapHubLayerVisibility } from '../components/map/useMapHubLayerVisibility';
import { useWeatherLayers } from '../components/map/useWeatherLayers';
import { useOpenSeaMapRasterHide } from '../components/map/mapHub/useOpenSeaMapRasterHide';
import { useEncAtOpen } from '../components/map/mapHub/useEncAtOpen';
import {
    __resetPassageHudForTests,
    getPassageHudActivation,
    getPassageHudPreviewRoute,
    getPassageLookAhead,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn } from '../stores/chartPassageOverlay';

vi.mock('../services/MobService', () => ({
    MobService: { isActive: () => true, subscribe: () => () => undefined },
}));
vi.mock('../components/map/useActiveCyclones', () => ({ useActiveCyclones: () => ({ cyclones: [] }) }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mapRef = { current: null as mapboxgl.Map | null };

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});

describe('clean OBS startup', () => {
    it('ignores stored overlay switches, keeps ownship and does not disarm MOB', () => {
        for (const key of ['ais', 'chokepoint', 'seamark', 'anchorage', 'moorings', 'tide_stations', 'lightning']) {
            localStorage.setItem(`thalassa_map_${key}_visible`, 'true');
        }
        localStorage.setItem('thalassa_map_vessel_tracking_visible', 'false');
        const { result, rerender } = renderHook(() => useMapHubLayerVisibility({ mapRef, planningSurface: false }));
        for (const [key, value] of Object.entries(result.current)) {
            if (key.endsWith('Visible') && typeof value === 'boolean' && key !== 'vesselTrackingVisible') {
                expect(value, key).toBe(false);
            }
        }
        expect(result.current.vesselTrackingVisible).toBe(true);
        expect(result.current.mobActive).toBe(true);
        act(() => result.current.setMooringsVisible(true));
        rerender();
        expect(result.current.browseMooringsVisible).toBe(true);
    });

    it('starts weather and protected areas off despite existing browser-session storage', () => {
        sessionStorage.setItem('thalassa_active_layers', '["wind","rain","pressure"]');
        localStorage.setItem('thalassa_mpa_visible', '1');
        const { result, rerender } = renderHook(
            ({ plan }) => useWeatherLayers(mapRef, false, false, { lat: -20, lon: 149 }, plan, undefined, true),
            { initialProps: { plan: false } },
        );
        expect(result.current.activeLayers.size).toBe(0);
        expect(result.current.mpaVisible).toBe(false);
        act(() => result.current.toggleLayer('rain'));
        rerender({ plan: true });
        expect(result.current.activeLayers.size).toBe(0);
        rerender({ plan: false });
        expect([...result.current.activeLayers]).toEqual(['rain']);
    });

    it('does not restore Passage, the HUD’s weather layers, a look-ahead or a preview from a previous launch', () => {
        // There is no HUD switch to restore (build 124): the HUD is standard. A
        // launch is never an activation, so it opens no weather layer.
        localStorage.setItem('thalassa_chart_passage_overlay_v1', '1');
        __resetPassageHudForTests();
        __resetPassageOverlayForTests();
        expect(getPassageHudActivation()).toBe(0);
        expect(getPassageHudPreviewRoute()).toBeNull();
        expect(getPassageLookAhead().on).toBe(false);
        expect(isPassageOverlayOn()).toBe(false);
    });

    it('does not reveal fallback seamarks just because ENC is off', () => {
        const visibility = new Map<string, string>();
        const map = {
            getLayer: () => ({}),
            getLayoutProperty: (id: string) => visibility.get(id),
            setLayoutProperty: (id: string, _property: string, value: string) => visibility.set(id, value),
            on: vi.fn(),
            off: vi.fn(),
        };
        const ref = { current: map as unknown as mapboxgl.Map };
        const layers = new Set<never>();
        const { rerender } = renderHook(
            ({ enabled }) => useOpenSeaMapRasterHide(ref, true, false, false, layers, enabled),
            {
                initialProps: { enabled: false },
            },
        );
        expect([...visibility.values()]).toEqual(['none', 'none', 'none', 'none']);
        rerender({ enabled: true });
        expect(visibility.get('openseamap-overlay')).toBe('visible');
        expect(visibility.get('harbour-seamarks-circle')).toBe('visible');
    });

    it('starts ENC off on a fresh OBS unless Preferences asks for it, whatever an old launch left behind', async () => {
        // The persisted switch Release 119 retired: a stale `true` must not
        // come back as the start state.
        localStorage.setItem('thalassa_map_enc_visible', 'true');
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        expect(DEFAULT_SETTINGS.obsEncOnOpen).not.toBe(true);
        const off = renderHook(() => useEncAtOpen(true, DEFAULT_SETTINGS.obsEncOnOpen));
        expect(off.result.current.encVisible).toBe(false);
        const on = renderHook(() => useEncAtOpen(true, true));
        expect(on.result.current.encVisible).toBe(true);
    });

    it('connects clean startup to OBS while retaining plotting ENC and safety layers', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('const [weatherInspectMode, setWeatherInspectMode] = useState(false)');
        // ENC at open follows Preferences → Chart (W1-01 slice 1b), off by
        // default; the case above pins the off default itself.
        expect(hub).toContain('const { encVisible, toggleEnc } = useEncAtOpen(ownshipStartup, settings.obsEncOnOpen);');
        expect(hub).toContain("const obsShowing = ownshipStartup && currentView === 'map';");
        // Build 124: with MapHub's count of other surfaces having had the map.
        expect(hub).toContain('useObsStartupCamera(mapRef, mapReady, obsShowing, obsStart, surfaceEpoch)');
        expect(hub).not.toContain('lastFlownCoordsRef');
        expect(hub).toContain('encSafetyDepthM, encHazardDepthM, coordCaptureMode)');
        expect(hub).toContain('useAnchorSwingLayer(mapRef, mapReady)');
        expect(hub).toContain('useChartCatalog(mapRef, mapReady, !planningSurface, true)');
    });
});
