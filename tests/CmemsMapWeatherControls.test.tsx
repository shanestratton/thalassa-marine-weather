import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/map/cmemsFeatureAvailability', () => ({
    isCmemsFeatureEnabled: () => true,
}));

import { MapWeatherControls } from '../components/map/MapWeatherControls';
import type { CmemsLayerLoadState } from '../components/map/useCmemsGridRefresh';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

function weather(overrides: Record<string, unknown> = {}): WeatherControlsWeather {
    return {
        activeLayers: new Set(['currents']),
        windModel: 'icon',
        setWindModel: vi.fn(),
        currentsHour: 0,
        currentsTotalHours: 13,
        currentsNowIdx: 0,
        currentsPlaying: false,
        setCurrentsHour: vi.fn(),
        setCurrentsPlaying: vi.fn(),
        wavesHour: 0,
        wavesTotalHours: 17,
        wavesNowIdx: 0,
        wavesPlaying: false,
        setWavesHour: vi.fn(),
        setWavesPlaying: vi.fn(),
        sstStep: 0,
        sstTotalSteps: 6,
        sstNowIdx: 0,
        sstPlaying: false,
        setSstStep: vi.fn(),
        setSstPlaying: vi.fn(),
        chlStep: 0,
        chlTotalSteps: 6,
        chlNowIdx: 0,
        chlPlaying: false,
        setChlStep: vi.fn(),
        setChlPlaying: vi.fn(),
        seaiceStep: 0,
        seaiceTotalSteps: 6,
        seaiceNowIdx: 0,
        seaicePlaying: false,
        setSeaiceStep: vi.fn(),
        setSeaicePlaying: vi.fn(),
        mldStep: 0,
        mldTotalSteps: 6,
        mldNowIdx: 0,
        mldPlaying: false,
        setMldStep: vi.fn(),
        setMldPlaying: vi.fn(),
        ...overrides,
    } as unknown as WeatherControlsWeather;
}

function cmemsState(overrides: Partial<CmemsLayerLoadState> = {}): CmemsLayerLoadState {
    return {
        phase: 'loading',
        requestedStep: 0,
        verifiedStep: null,
        sourceGeneration: null,
        presentation: 'absent',
        attempt: 1,
        retry: vi.fn(),
        ...overrides,
    };
}

const controls = {
    visible: true,
    embedded: false,
    controlsHidden: false,
    onControlsHiddenChange: vi.fn(),
} as const;

describe('MapWeatherControls CMEMS render honesty', () => {
    it('shows honest loading and unavailable states and only exposes the exact rendered step', () => {
        const loading = cmemsState();
        const { rerender } = render(
            <MapWeatherControls weather={weather()} cmemsLayerStates={{ currents: loading }} {...controls} />,
        );

        expect(screen.getByRole('status')).toHaveTextContent('Loading…');
        expect(screen.getByRole('status')).toHaveTextContent('Verifying currents');
        expect(screen.queryByRole('button', { name: 'Currents layer' })).not.toBeInTheDocument();

        const unavailable = cmemsState({ phase: 'error' });
        rerender(<MapWeatherControls weather={weather()} cmemsLayerStates={{ currents: unavailable }} {...controls} />);

        expect(screen.getByRole('alert')).toHaveTextContent('Unavailable');
        expect(screen.getByRole('alert')).toHaveTextContent('Retry from alert');
        expect(screen.queryByRole('button', { name: 'Currents layer' })).not.toBeInTheDocument();

        const ready = cmemsState({
            phase: 'ready',
            requestedStep: 0,
            verifiedStep: 0,
            sourceGeneration: 'g-20260805T120000Z-aaaaaaaaaaaa',
            presentation: 'visible',
        });
        rerender(<MapWeatherControls weather={weather()} cmemsLayerStates={{ currents: ready }} {...controls} />);

        expect(screen.getByRole('button', { name: 'Currents layer' })).toBeVisible();
        expect(screen.getByRole('slider', { name: 'Currents timeline' })).toHaveAttribute(
            'aria-valuetext',
            'Now — Nowcast',
        );
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

        rerender(
            <MapWeatherControls
                weather={weather({ currentsHour: 1 })}
                cmemsLayerStates={{ currents: ready }}
                {...controls}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent('Loading…');
        expect(screen.queryByRole('button', { name: 'Currents layer' })).not.toBeInTheDocument();
        expect(screen.queryByText('+1h')).not.toBeInTheDocument();
    });

    it('hides a requested current legend in a stack until its exact step renders', () => {
        const loading = cmemsState();
        const stackedWeather = weather({ activeLayers: new Set(['wind', 'currents']) });
        const { rerender } = render(
            <MapWeatherControls weather={stackedWeather} cmemsLayerStates={{ currents: loading }} {...controls} />,
        );

        expect(screen.getByRole('button', { name: 'Show Wind legend' })).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Show Currents legend' })).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Currents · Loading…');

        const ready = cmemsState({
            phase: 'ready',
            requestedStep: 0,
            verifiedStep: 0,
            sourceGeneration: 'g-20260805T120000Z-bbbbbbbbbbbb',
            presentation: 'visible',
        });
        rerender(<MapWeatherControls weather={stackedWeather} cmemsLayerStates={{ currents: ready }} {...controls} />);

        expect(screen.getByRole('button', { name: 'Show Wind legend' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Show Currents legend' })).toBeVisible();
        expect(screen.queryByRole('status')).not.toBeInTheDocument();

        rerender(
            <MapWeatherControls
                weather={weather({ activeLayers: new Set(['wind', 'currents']), currentsHour: 1 })}
                cmemsLayerStates={{ currents: ready }}
                {...controls}
            />,
        );

        expect(screen.getByRole('button', { name: 'Show Wind legend' })).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Show Currents legend' })).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Currents · Loading…');
    });
});
