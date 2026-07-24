import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('mapbox-gl', () => ({
    default: {
        LngLatBounds: class {
            extend() {
                return this;
            }
        },
    },
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({
        speed: 'kts',
        length: 'm',
        waveHeight: 'm',
        tideHeight: 'm',
        temp: 'C',
        distance: 'nm',
        visibility: 'nm',
        volume: 'l',
    }),
}));

vi.mock('../services/WeatherRoutingService', () => ({ computeRoute: vi.fn() }));
vi.mock('../services/IsochroneRouter', () => ({
    computeIsochrones: vi.fn(),
    isochroneToGeoJSON: vi.fn(),
    detectTurnWaypoints: vi.fn(),
}));
vi.mock('../services/isochrone/geodesy', () => ({ cumulativeLegs: vi.fn(() => []) }));
vi.mock('../services/BathymetryCache', () => ({ preloadBathymetry: vi.fn() }));
vi.mock('../services/weather/WindFieldAdapter', () => ({ createWindFieldFromGrid: vi.fn() }));
vi.mock('../services/defaultPolar', () => ({ DEFAULT_CRUISING_POLAR: {} }));
vi.mock('../services/SmartPolarStore', () => ({
    SmartPolarStore: { exportToPolarData: vi.fn(() => null) },
}));
vi.mock('../stores/WindStore', () => ({
    WindStore: {
        getState: vi.fn(() => ({ grid: null })),
        setGrid: vi.fn(),
    },
}));
vi.mock('../stores/PassageStore', () => ({
    PassageStore: {
        clear: vi.fn(),
        setFromRoute: vi.fn(),
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: vi.fn(() => ({ settings: { vessel: null } })),
    },
}));
vi.mock('../services/weather/WindDataController', () => ({
    WindDataController: { activate: vi.fn() },
}));
vi.mock('../services/ComfortZoneEngine', () => ({
    generateComfortZoneOverlay: vi.fn(),
    hasActiveComfortLimits: vi.fn(() => false),
}));
vi.mock('../services/units', () => ({
    vesselDraftMetres: vi.fn(() => 0),
    vesselAirDraftMetres: vi.fn(() => 0),
}));

import { usePassagePlanner } from '../components/map/usePassagePlanner';
import { clearPassageRequest, peekPassageRequest, stagePassageRequest } from '../services/passageHandoff';

describe('usePassagePlanner passage handoff lifecycle', () => {
    beforeEach(() => {
        clearPassageRequest();
        vi.clearAllMocks();
    });

    it('enters passage mode on the first render when a request was staged before navigation', () => {
        const handoff = {
            departure: { lat: -27.4698, lon: 153.0251, name: 'Brisbane' },
            arrival: { lat: -27.163, lon: 153.442, name: 'Moreton Island' },
        };
        stagePassageRequest(handoff);
        const renderHistory: boolean[] = [];
        const mapRef = { current: null } as never;

        const { result } = renderHook(() => {
            const passage = usePassagePlanner(mapRef, false);
            renderHistory.push(passage.showPassage);
            return passage;
        });

        expect(renderHistory[0]).toBe(true);
        expect(result.current.showPassage).toBe(true);
        expect(result.current.departure).toEqual(handoff.departure);
        expect(result.current.arrival).toEqual(handoff.arrival);
    });

    it('clearRoute removes the sticky request so a later mount cannot resurrect it', () => {
        stagePassageRequest({
            departure: { lat: -27.4698, lon: 153.0251, name: 'Brisbane' },
        });
        const mapRef = { current: null } as never;
        const rendered = renderHook(() => usePassagePlanner(mapRef, false));

        expect(peekPassageRequest()).not.toBeNull();
        act(() => rendered.result.current.clearRoute());

        expect(peekPassageRequest()).toBeNull();
        expect(rendered.result.current.departure).toBeNull();
        expect(rendered.result.current.arrival).toBeNull();

        rendered.unmount();
        const remounted = renderHook(() => usePassagePlanner(mapRef, false));
        expect(remounted.result.current.showPassage).toBe(false);
    });
});
