import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PassageHudPane } from '../../components/passage/PassageHudPane';
import { MapWeatherControls } from '../../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../../components/map/useWeatherLayers';
import {
    setPassageHudEnabled,
    setPassageHudOpen,
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
setPassageHudEnabled(true);
setPassageHudOpen(true);
const mode = new URLSearchParams(location.search).get('mode') ?? 'recording';
if (mode !== 'recording') {
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
                {mode === 'recording' ? 'Recording without a followed route' : 'Following a sample route'}
            </div>
            <PassageHudPane />
            <MapWeatherControls
                weather={weather}
                visible
                embedded={false}
                controlsHidden={hidden}
                onControlsHiddenChange={setHidden}
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
