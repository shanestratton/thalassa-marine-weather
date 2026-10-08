import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PassageHudPane } from '../../components/passage/PassageHudPane';
import { MapWeatherControls } from '../../components/map/MapWeatherControls';
import { SatelliteIrCredit } from '../../components/map/SatelliteIrCredit';
import { BlitzortungAttribution } from '../../components/map/BlitzortungAttribution';
import {
    CREDITS_STRIP_POSITION_CLASS,
    creditsStripTop,
    satelliteCreditOffsetPx,
} from '../../components/map/creditsStrip';
import type { useWeatherLayers } from '../../components/map/useWeatherLayers';
import {
    setPassageHudOpen,
    setPassageHudPreviewRoute,
    startPassageLookAhead,
    stopPassageLookAhead,
    usePassageHudOpen,
} from '../../stores/passageHudStore';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import type { WeatherModelId } from '../../services/weather/MultiModelWeatherService';
import type { VoyagePlan } from '../../types';
import '../../index.css';

// The Playwright spec supplies synthetic read-only hooks before loading this
// real component tree. No account, GPS, recorder or weather fetch is started.
useFollowRouteStore.getState().stopFollowing();
stopPassageLookAhead();
setPassageHudOpen(true);
const mode = new URLSearchParams(location.search).get('mode') ?? 'recording';
// ?credits=1: the Sat cloud and lightning credits are up in the credits strip,
// at MapHub's own slots, as on a chart with both layers on (build 124 HS).
// ?credits=sat: the Sat cloud's alone — lightning is off behind its licence flag.
const creditsParam = new URLSearchParams(location.search).get('credits');
const credits = creditsParam === '1' || creditsParam === 'sat';
const lightningCredit = creditsParam === '1';
// ?extras=1: a non-weather layer key is on too, as on a real passage (the route,
// track and passage layers), so the controls are labelled 'layer controls' and
// stay offered while looking ahead.
const extras = new URLSearchParams(location.search).get('extras') === '1';
if (mode === 'preview') {
    // A route pulled up on Obs and not followed (build 124 HS): a fictional
    // Channel crossing, previewed — nothing is followed.
    setPassageHudPreviewRoute({
        id: 'layout-preview',
        label: 'Cowes → Cherbourg',
        points: [
            { lat: 50.77, lon: -1.3 },
            { lat: 50.3, lon: -1.45 },
            { lat: 49.66, lon: -1.62 },
        ],
    });
} else if (mode !== 'recording') {
    useFollowRouteStore
        .getState()
        .startFollowing(
            { origin: 'Butterfly Bay', destination: 'Daydream Island', waypoints: [] } as unknown as VoyagePlan,
            'layout-route',
            [
                { lat: -27.5, lon: 153 },
                { lat: -27.2, lon: 153 },
            ],
        );
    if (mode === 'forecast') startPassageLookAhead();
}

const hours = Array.from({ length: 13 }, (_, hour) => hour);
const grid = {
    u: hours.map(() => new Float32Array([1])),
    v: hours.map(() => new Float32Array([1])),
    speed: hours.map(() => new Float32Array([1])),
    width: 1,
    height: 1,
    lats: [0],
    lons: [0],
    north: 0,
    south: 0,
    west: 0,
    east: 0,
    totalHours: hours.length,
    // The timeline names each frame's valid time (UTC) from the model run.
    refTime: '2026-09-27T06:00:00.000Z',
};

function Fixture() {
    const open = usePassageHudOpen();
    const [hour, setHour] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [model, setModel] = useState<WeatherModelId>('icon');
    const weather = {
        activeLayers: new Set(['wind']),
        windForecastHours: hours,
        windForecastHoursRef: { current: hours },
        windNowIdx: 0,
        windNowIdxRef: { current: 0 },
        windHour: hour,
        windTotalHours: hours.length,
        windPlaying: playing,
        windReady: true,
        setWindHour: setHour,
        setWindPlaying: setPlaying,
        windModel: model,
        setWindModel: setModel,
        windState: { loading: false, error: null, grid },
    } as unknown as ReturnType<typeof useWeatherLayers>;
    return (
        <main
            className="relative h-full overflow-hidden bg-slate-900 text-white"
            data-passage-hud={open ? 'open' : 'closed'}
            style={{ backgroundImage: 'radial-gradient(ellipse at 70% 40%, #143b4d, #0f172a 70%)' }}
        >
            <header className="flex h-14 items-center justify-between border-b border-white/10 px-3 text-xs">
                <span className="font-black tracking-widest">OBS</span>
                <span className="text-slate-400">Synthetic chart · no network</span>
            </header>
            <div className="absolute right-5 top-24 max-w-40 text-right text-xs leading-relaxed text-slate-400">
                {mode === 'recording'
                    ? 'Recording without a followed route'
                    : mode === 'preview'
                      ? 'Previewing a route pulled up on Obs'
                      : 'Following a sample route'}
            </div>
            {credits && (
                <>
                    {lightningCredit && (
                        <div
                            data-testid="lightning-credit"
                            className={`${CREDITS_STRIP_POSITION_CLASS} z-510 max-w-[calc(100%-120px)] pointer-events-none`}
                            style={{ top: creditsStripTop(0) }}
                        >
                            <BlitzortungAttribution visible compact />
                        </div>
                    )}
                    <SatelliteIrCredit
                        state={{
                            status: 'ready',
                            frameTimeMs: Date.now() - 2 * 3_600_000,
                            frameCount: 6,
                            // The widest the chip gets in open water: the low-angle caveat.
                            coverage: { outside: null, edgeNorth: false, edgeSouth: false, lowAngle: true },
                            playing: false,
                            following: false,
                        }}
                        top={creditsStripTop(
                            satelliteCreditOffsetPx({ rain: false, cmems: false, lightning: lightningCredit }),
                        )}
                        onTogglePlay={() => undefined}
                    />
                </>
            )}
            <PassageHudPane />
            <MapWeatherControls
                weather={weather}
                visible
                embedded={false}
                controlsHidden={hidden}
                onControlsHiddenChange={setHidden}
                extraLegend={
                    extras ? (
                        <section aria-label="Routes & tracks key" className="text-xs text-slate-300">
                            Purple · planned route, not proof of a safe passage.
                        </section>
                    ) : undefined
                }
                extraLegendCount={extras ? 1 : undefined}
            />
            <nav
                aria-label="Main"
                className="absolute inset-x-0 bottom-0 flex h-16 items-center justify-center border-t border-white/10 bg-slate-950 text-xs text-slate-400"
            >
                Layout fixture · actual HUD and weather controls
            </nav>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
