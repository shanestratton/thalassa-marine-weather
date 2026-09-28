import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MapWeatherControls } from '../../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../../components/map/useWeatherLayers';
import type { WeatherModelId } from '../../services/weather/MultiModelWeatherService';
import { ObsLayerKey, obsLayerKeyCount, type ObsLayerKeyProps } from '../../components/map/ObsLayerKey';
import type { MooringColourFilter } from '../../services/anchorages/cruisingReference';
import { startPassageLookAhead, stopPassageLookAhead, usePassageLookAheadOn } from '../../stores/passageHudStore';
import '../../index.css';

const reference = Date.parse('2026-09-27T06:00:00Z');
const hours = [0, 1, 3, 6, 9];
const fields = hours.map(() => new Float32Array([1]));
const grid = {
    u: fields,
    v: fields,
    speed: fields,
    totalHours: hours.length,
    refTime: new Date(reference).toISOString(),
};
const rainFrames = [0, 10, 30, 90].map((minutes) => ({
    type: minutes === 0 ? 'radar' : 'forecast',
    timeMs: reference + minutes * 60_000,
    label: minutes === 0 ? '06:00' : `+${minutes}m`,
}));

function Fixture() {
    const params = new URLSearchParams(location.search);
    const autoHideFixture = params.get('autohide') === '1';
    const extrasMode = params.get('extras');
    const hasExtras = extrasMode === 'only' || extrasMode === 'combined';
    const selectProbe = autoHideFixture && extrasMode === 'select';
    const lookingAhead = usePassageLookAheadOn();
    const [mooringFilter, setMooringFilter] = useState<MooringColourFilter>('all');
    const [hidden, setHidden] = useState(false);
    const [windHour, setWindHour] = useState(0);
    const [rainFrameIndex, setRainFrameIndex] = useState(0);
    const [currentsHour, setCurrentsHour] = useState(0);
    const [windPlaying, setWindPlaying] = useState(false);
    const [rainPlaying, setRainPlaying] = useState(false);
    const [currentsPlaying, setCurrentsPlaying] = useState(false);
    const [model, setModel] = useState<WeatherModelId>('icon');
    const [mapClicks, setMapClicks] = useState(0);
    useEffect(() => {
        if (!autoHideFixture || (!windPlaying && !rainPlaying)) return;
        const timer = window.setInterval(() => {
            if (windPlaying) setWindHour((hour) => (Math.round(hour) + 1) % hours.length);
            if (rainPlaying) setRainFrameIndex((frame) => (frame + 1) % rainFrames.length);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [autoHideFixture, windPlaying, rainPlaying]);
    const weather = {
        activeLayers: new Set(
            extrasMode === 'only' ? [] : ['wind', 'rain', 'pressure', 'temperature', 'clouds', 'currents'],
        ),
        windHour,
        setWindHour,
        windPlaying,
        setWindPlaying,
        windReady: true,
        windForecastHours: hours,
        windNowIdx: 0,
        windState: { loading: false, error: null, grid },
        windModel: model,
        setWindModel: setModel,
        rainFrameIndex,
        setRainFrameIndex,
        rainPlaying,
        setRainPlaying,
        rainReady: true,
        rainFrameCount: rainFrames.length,
        rainNowIdxRef: { current: 0 },
        unifiedFramesRef: { current: rainFrames },
        forecastHour: hours[Math.round(windHour)],
        totalFrames: 24,
        framesReady: 24,
        pressureNowIdx: 0,
        pressureFrameStepHours: 1,
        pressureSource: 'gfs',
        pressureRefTime: new Date(reference).toISOString(),
        pressureClockMs: reference,
        pressureValidTimeMs: reference + hours[Math.round(windHour)] * 3_600_000,
        pressureFollowsWind: true,
        pressureTimeUnavailable: null,
        currentsHour,
        setCurrentsHour,
        currentsPlaying,
        setCurrentsPlaying,
        currentsNowIdx: 0,
        currentsTotalHours: 13,
    } as unknown as ReturnType<typeof useWeatherLayers>;
    const extras: ObsLayerKeyProps = {
        ais: true,
        lightning: true,
        squall: true,
        storms: true,
        tides: true,
        moorings: true,
        anchorages: true,
        marks: true,
        protectedAreas: true,
        route: true,
        track: true,
        passage: true,
        forecastRoute: true,
        verificationStatus: 'unverified',
        referenceStatus: 'Cached reference coverage · verify access locally',
        mooringFilter,
        onMooringFilter: setMooringFilter,
        tideStatus: { stationCount: 3, loading: false, error: false, zoomRequired: false },
    };
    return (
        <main
            className="relative h-dvh overflow-hidden bg-slate-900 text-white"
            data-testid="weather-fixture"
            data-controls-hidden={String(hidden)}
            data-wind-playing={String(windPlaying)}
            data-rain-playing={String(rainPlaying)}
            data-wind-hour={windHour}
            data-rain-frame={rainFrameIndex}
            data-wind-model={model}
            data-map-clicks={mapClicks}
        >
            <div
                aria-hidden="true"
                className="absolute inset-0 opacity-20"
                style={{
                    backgroundImage:
                        'linear-gradient(#64748b 1px, transparent 1px), linear-gradient(90deg, #64748b 1px, transparent 1px)',
                    backgroundSize: '44px 44px',
                }}
            />
            <header className="absolute left-4 top-4 text-sm font-bold">OBS · local layout fixture</header>
            {autoHideFixture && (
                <button
                    type="button"
                    data-testid="fixture-map-target"
                    className="absolute bottom-[180px] left-6 min-h-[44px] min-w-[44px] rounded-lg bg-sky-800 px-3"
                    onClick={() => setMapClicks((count) => count + 1)}
                >
                    Map click target
                </button>
            )}
            <MapWeatherControls
                weather={weather}
                cmemsLayerStates={{
                    currents: {
                        phase: 'ready',
                        requestedStep: currentsHour,
                        verifiedStep: currentsHour,
                        sourceGeneration: 'fixture-generation',
                        presentation: 'visible',
                        attempt: 1,
                        retry: () => {},
                    },
                }}
                visible
                embedded={false}
                controlsHidden={hidden}
                onControlsHiddenChange={setHidden}
                extraLegend={
                    hasExtras ? (
                        <ObsLayerKey {...extras} />
                    ) : selectProbe ? (
                        <label className="block text-xs">
                            Fixture native selection
                            <select aria-label="Fixture native selection" className="ml-2 min-h-[44px] bg-slate-800">
                                <option>All reference markers</option>
                                <option>Available reference markers</option>
                            </select>
                        </label>
                    ) : undefined
                }
                extraLegendCount={hasExtras ? obsLayerKeyCount(extras) : selectProbe ? 1 : undefined}
            />
            <nav
                aria-label="Main"
                className="absolute inset-x-0 bottom-0 flex h-16 items-center justify-around border-t border-white/10 bg-slate-950"
            >
                {hasExtras && (
                    <button
                        type="button"
                        className="min-h-[44px] min-w-[44px] px-2 text-xs"
                        onClick={() => (lookingAhead ? stopPassageLookAhead() : startPassageLookAhead())}
                    >
                        {lookingAhead ? 'End look-ahead' : 'Start look-ahead'}
                    </button>
                )}
                {(hasExtras ? ['OBS', 'Vessel'] : ['Weather', 'OBS', 'Log', 'Vessel']).map((name) => (
                    <button type="button" key={name} className="min-h-[44px] min-w-[44px] px-2 text-xs">
                        {name}
                    </button>
                ))}
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
