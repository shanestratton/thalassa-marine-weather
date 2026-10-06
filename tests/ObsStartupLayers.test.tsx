import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { readFileSync } from 'node:fs';
import { useMapHubLayerVisibility } from '../components/map/useMapHubLayerVisibility';
import { useWeatherLayers } from '../components/map/useWeatherLayers';
import { useOpenSeaMapRasterHide } from '../components/map/mapHub/useOpenSeaMapRasterHide';
import { __resetPassageHudForTests, isPassageHudEnabled } from '../stores/passageHudStore';
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

    it('does not restore Passage/HUD from a previous launch', () => {
        localStorage.setItem('thalassa_passage_hud_enabled_v1', '1');
        localStorage.setItem('thalassa_chart_passage_overlay_v1', '1');
        __resetPassageHudForTests();
        __resetPassageOverlayForTests();
        expect(isPassageHudEnabled()).toBe(false);
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

    it('connects clean startup to OBS while retaining plotting ENC and safety layers', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('const [weatherInspectMode, setWeatherInspectMode] = useState(false)');
        expect(hub).toContain('const [encVisible, setEncVisible] = useState(false)');
        expect(hub).toContain(
            "useObsStartupCamera(mapRef, mapReady, ownshipStartup && currentView === 'map', obsStart)",
        );
        expect(hub).not.toContain('lastFlownCoordsRef');
        expect(hub).toContain('encSafetyDepthM, encHazardDepthM, coordCaptureMode)');
        expect(hub).toContain('useAnchorSwingLayer(mapRef, mapReady)');
        expect(hub).toContain('useChartCatalog(mapRef, mapReady, !planningSurface, true)');
    });
});
