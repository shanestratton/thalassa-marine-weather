import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PassageRouteState } from '../stores/PassageStore';

const passageState = vi.hoisted(() => ({
    value: {
        hasRoute: false,
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

const weatherMocks = vi.hoisted(() => ({
    fetchRouteMaxConditions: vi.fn().mockResolvedValue({
        maxWindKts: 24,
        maxWaveM: 2.4,
        sampledPoints: 3,
        forecastPoints: 3,
        beyondForecast: false,
    }),
}));

vi.mock('../stores/PassageStore', () => ({
    usePassageStore: () => passageState.value,
}));

vi.mock('../components/passage/PassageRouteMap', () => ({
    PassageRouteMap: () => <div data-testid="passage-route-map" />,
}));

vi.mock('../components/passage/SharePassageButton', () => ({
    default: ({
        briefData,
        allowFloatPlan,
    }: {
        briefData: { vesselName?: string; speed?: number } | null;
        allowFloatPlan?: boolean;
    }) => (
        <div
            data-testid="share-passage"
            data-vessel={briefData?.vesselName ?? ''}
            data-speed={String(briefData?.speed)}
            data-float-plan={String(allowFloatPlan)}
        />
    ),
}));

const settingsState = vi.hoisted(() => ({
    value: { vessel: { name: 'Kestrel', cruisingSpeed: 6 } } as { vessel: { name: string; cruisingSpeed: number } },
}));

vi.mock('../components/TrackMapViewer', () => ({
    TrackMapViewer: () => <div data-testid="track-map-viewer" />,
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: settingsState.value }),
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
    fetchRouteMaxConditions: weatherMocks.fetchRouteMaxConditions,
}));

import { PassageSummaryCard } from '../components/passage/PassageSummaryCard';

describe('PassageSummaryCard route title', () => {
    it('collapses legacy generated trace endpoints into one human route title', () => {
        const generatedStart = '27.125S 153E - Woorim - Start';
        const generatedEnd = '27.12S 153.12E - Woorim - end';

        render(
            <PassageSummaryCard
                voyageId="planned-woorim"
                voyageName={`${generatedStart} -> ${generatedEnd}`}
                departPort={generatedStart}
                destPort={generatedEnd}
            />,
        );

        expect(screen.getByText('27.12S 153.12E - Woorim', { exact: true })).toBeInTheDocument();
        expect(screen.queryByText(`${generatedStart} → ${generatedEnd}`, { exact: true })).not.toBeInTheDocument();
    });

    it('uses the saved curved route, vessel speed, and selected departure instead of stale global passage values', async () => {
        passageState.value = {
            ...passageState.value,
            hasRoute: true,
            departLat: -27,
            departLon: 153,
            arriveLat: -26,
            arriveLon: 154,
            totalDistanceNM: 9999,
            arrivalTime: '2099-01-20T00:00:00.000Z',
            maxWindKt: 88,
            maxWaveM: 12,
        };
        const onDepartureTimeChange = vi.fn();
        const routeCoordinates = [
            { lat: -27, lon: 153 },
            { lat: -26, lon: 153 },
            { lat: -26, lon: 154 },
        ];

        render(
            <PassageSummaryCard
                voyageId="planned-corner"
                departPort="Start"
                destPort="Finish"
                departureTime="2099-01-01T01:00:00.000Z"
                routeCoordinates={routeCoordinates}
                onDepartureTimeChange={onDepartureTimeChange}
            />,
        );

        // Distance now reads 'NM', the spelling used everywhere else in the app.
        expect(screen.getByText(/11\d\.\d NM/)).toBeInTheDocument();
        expect(screen.getByText(/19h/)).toBeInTheDocument();
        expect(await screen.findByText('24kt')).toBeInTheDocument();
        expect(screen.getByText('2.4m')).toBeInTheDocument();
        expect(screen.queryByText('88kt')).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Departure Time'), { target: { value: '05:00' } });
        await act(async () => {
            await Promise.resolve();
        });
        expect(onDepartureTimeChange).toHaveBeenCalledTimes(1);
        const [departureIso, etaIso] = onDepartureTimeChange.mock.calls[0];
        expect(Date.parse(etaIso) - Date.parse(departureIso)).toBeGreaterThan(18 * 3_600_000);
        expect(Date.parse(etaIso) - Date.parse(departureIso)).toBeLessThan(20 * 3_600_000);
    });

    it("on the skipper's passage, the brief and the timings are the skipper's boat, never your own", () => {
        // Your own boat is fast, and your own chart happens to hold the same run.
        settingsState.value = { vessel: { name: 'Kestrel', cruisingSpeed: 12 } };
        passageState.value = { ...passageState.value, hasRoute: true, vesselName: 'Kestrel' };
        const routeCoordinates = [
            { lat: -27, lon: 153 },
            { lat: -26, lon: 153 },
            { lat: -26, lon: 154 },
        ];
        const props = {
            voyageId: 'skipper-passage',
            departPort: 'Start',
            destPort: 'Finish',
            departureTime: '2099-01-01T01:00:00.000Z',
            routeCoordinates,
            allowFloatPlan: false,
        };
        try {
            const { unmount } = render(
                <PassageSummaryCard {...props} passageVessel={{ name: 'Wandering Albatross', cruisingSpeed: 8 }} />,
            );
            const share = screen.getByTestId('share-passage');
            expect(share).toHaveAttribute('data-vessel', 'Wandering Albatross');
            expect(share).toHaveAttribute('data-speed', '8');
            expect(share).toHaveAttribute('data-float-plan', 'false');
            expect(screen.getByText(/14h/)).toBeInTheDocument();
            unmount();

            // No profile of the skipper's boat yet: no boat name, the default speed.
            render(<PassageSummaryCard {...props} passageVessel={null} />);
            expect(screen.getByTestId('share-passage')).toHaveAttribute('data-vessel', '');
            expect(screen.getByTestId('share-passage')).toHaveAttribute('data-speed', '6');
            expect(screen.getByText(/19h/)).toBeInTheDocument();
        } finally {
            settingsState.value = { vessel: { name: 'Kestrel', cruisingSpeed: 6 } };
        }
    });
});
