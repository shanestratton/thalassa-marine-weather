import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';
import { readFileSync } from 'node:fs';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { useWeatherLayers } from '../components/map/useWeatherLayers';
import {
    __resetPassageHudForTests,
    getPassageUnsyncedLayers,
    startPassageLookAhead,
    stopPassageLookAhead,
} from '../stores/passageHudStore';

const LOCATION = { lat: -27.4698, lon: 153.0251 };
const mapRef = { current: null } as MutableRefObject<mapboxgl.Map | null>;

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetPassageHudForTests();
});

describe('passage weather context', () => {
    it('warns that separate Squall rain/cloud imagery does not follow the forecast clock', () => {
        const rendered = renderHook(
            ({ squallVisible, planMode }) =>
                useWeatherLayers(mapRef, false, false, LOCATION, planMode, LOCATION, {
                    hudEnabled: true,
                    squallVisible,
                }),
            { initialProps: { squallVisible: true, planMode: false } },
        );
        expect(getPassageUnsyncedLayers()).toEqual([]);
        act(() => startPassageLookAhead());
        expect(getPassageUnsyncedLayers()).toEqual(['squall/clouds']);

        act(() => rendered.result.current.setLayerVisibility('rain', true));
        expect(getPassageUnsyncedLayers()).toEqual(['rain', 'squall/clouds']);

        rendered.rerender({ squallVisible: false, planMode: false });
        expect(getPassageUnsyncedLayers()).toEqual(['rain']);
        rendered.rerender({ squallVisible: true, planMode: true });
        expect(getPassageUnsyncedLayers()).toEqual([]);
        rendered.rerender({ squallVisible: true, planMode: false });
        expect(getPassageUnsyncedLayers()).toEqual(['rain', 'squall/clouds']);
        act(() => stopPassageLookAhead());
        expect(getPassageUnsyncedLayers()).toEqual([]);
    });

    it('keeps weather framing and zoom limits out of the passage-owned camera', () => {
        const source = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        const framing = source.slice(
            source.indexOf('// ── Center map when switching layers'),
            source.indexOf('// Rain auto-play'),
        );
        expect(framing).toContain('if (passageOwnsCamera) {');
        expect(framing).toContain('map.setMinZoom(0);');
        expect(framing).toContain('map.setMaxZoom(22);');
        expect(framing).toContain('if (passageOwnsCamera) return;');
        expect(framing).toContain('prevWindOnRef.current = windOn;');
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain('{ hudEnabled: passageHudOnChart, squallVisible: browseSquallVisible }');
    });
});
