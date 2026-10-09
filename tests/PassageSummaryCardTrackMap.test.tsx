/**
 * PassageSummaryCard still opens the real fullscreen track map (125-13b): a
 * tap on its route picture opens TrackMapViewer, now Mapbox GL on Relief +
 * Sat (lazy), with the voyage's track; closing it removes the map. The card's
 * own tests (PassageSummaryCard.test.tsx) stub the viewer; this one does not.
 * A fictional passage in the Solent.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PassageRouteState } from '../stores/PassageStore';
import type { ShipLogEntry } from '../types';
import { FakeMapboxMap } from './helpers/fakeMapboxGl';

const minute = (n: number) => new Date(Date.UTC(2026, 5, 1, 8, n)).toISOString();
const SAILED: ShipLogEntry[] = [
    [50.766, -1.296],
    [50.772, -1.33],
    [50.768, -1.37],
    [50.75, -1.41],
].map(
    ([latitude, longitude], i) =>
        ({
            id: `sailed-${i}`,
            userId: 'fixture-skipper',
            voyageId: 'fixture-passage',
            latitude,
            longitude,
            timestamp: minute(i * 10),
            positionFormatted: '',
            entryType: 'auto',
            source: 'device',
            windSpeed: 12,
        }) as ShipLogEntry,
);

const passageState = vi.hoisted(() => ({
    value: {
        hasRoute: true,
        routeName: null,
        departPort: null,
        destPort: null,
        departLat: null,
        departLon: null,
        arriveLat: null,
        arriveLon: null,
        departureTime: null,
        arrivalTime: null,
        totalDistanceNM: 0,
        totalDurationHours: 0,
        avgSpeedKts: null,
        maxWindKt: null,
        maxWaveM: null,
        vesselName: null,
        routeCoordinates: [] as [number, number][],
        turnWaypoints: [],
        legs: [],
    } as PassageRouteState,
}));

const track = vi.hoisted(() => ({ cached: null as unknown[] | null, all: [] as unknown[] }));

vi.mock('../stores/PassageStore', () => ({ usePassageStore: () => passageState.value }));
vi.mock('../components/passage/PassageRouteMap', () => ({
    PassageRouteMap: () => <div data-testid="passage-route-map" />,
}));
vi.mock('../components/passage/SharePassageButton', () => ({ default: () => null }));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: { name: 'Sea Wren', cruisingSpeed: 6 } } }),
}));
vi.mock('../hooks/useReadinessSync', () => ({
    useReadinessIdentityScope: () => 'test-skipper',
    useScopedReadinessStorageState: () => ['', vi.fn()],
}));
vi.mock('../services/authIdentityScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/authIdentityScope')>()),
    isAuthIdentityScopeCurrent: () => true,
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
vi.mock('../services/routeReportWeather', () => ({
    fetchRouteMaxConditions: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/shiplog/VoyageTrackCache', () => ({
    getCachedVoyageTrack: vi.fn(async () => track.cached),
    setCachedVoyageTrack: vi.fn(async () => undefined),
}));
vi.mock('../services/shiplog/EntryCrud', () => ({ getLogEntries: vi.fn(async () => track.all) }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { canDisplayProxiedTiles: () => false, passthroughTileUrl: () => null },
}));
vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});
vi.mock('leaflet', () => {
    throw new Error('the track map must not import Leaflet');
});

import { PassageSummaryCard } from '../components/passage/PassageSummaryCard';

beforeEach(() => {
    FakeMapboxMap.instances.length = 0;
    FakeMapboxMap.attempts = 0;
    track.cached = SAILED;
    track.all = SAILED;
    vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.fixture');
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(844);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('PassageSummaryCard opens the Relief + Sat track map', () => {
    it('renders, opens the fullscreen map with the voyage’s track, and removes the map on close', async () => {
        render(
            <PassageSummaryCard
                voyageId="fixture-passage"
                departPort="Cowes"
                destPort="Yarmouth"
                departureTime="2099-01-01T08:00:00.000Z"
                routeCoordinates={[
                    { lat: 50.766, lon: -1.296 },
                    { lat: 50.772, lon: -1.33 },
                    { lat: 50.75, lon: -1.41 },
                ]}
            />,
        );
        expect(screen.getByTestId('passage-route-map')).toBeInTheDocument();
        expect(FakeMapboxMap.attempts).toBe(0);

        fireEvent.click(screen.getByRole('button', { name: 'Open fullscreen track view' }));
        expect(await screen.findByRole('dialog', { name: 'Voyage track viewer' })).toBeInTheDocument();
        await waitFor(() => expect(FakeMapboxMap.instances).toHaveLength(1));
        const map = FakeMapboxMap.instances[0];
        map.loadStyle();
        await waitFor(() => {
            const data = map.getSource('track-line')?.data as GeoJSON.FeatureCollection | undefined;
            const coords = data?.features.flatMap((f) => (f.geometry as GeoJSON.LineString).coordinates) ?? [];
            expect(coords).toContainEqual([-1.41, 50.75]);
        });
        expect(screen.getByRole('slider', { name: 'Track playback position' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Close track map viewer' }));
        expect(map.remove).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog', { name: 'Voyage track viewer' })).not.toBeInTheDocument();
        expect(screen.getByTestId('passage-route-map')).toBeInTheDocument();
    });
});
