/** Real Glass components with deterministic data; no account or weather fetches. */
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { HeroWidgets } from '../../components/dashboard/HeroWidgets';
import { MetricGridPanel, type MetricWidget } from '../../components/dashboard/hero/MetricGridPanel';
import { DailySummaryCard } from '../../components/dashboard/hero/DailySummaryCard';
import { CompactHeaderRow } from '../../components/dashboard/CompactHeaderRow';
import { TideGraph } from '../../components/dashboard/tide/TideGraph';
import { ThermometerIcon, GaugeIcon, CompassIcon, CloudIcon, WaveIcon } from '../../components/Icons';
import type { UnitPreferences, WeatherMetrics } from '../../types';
import '../../index.css';
// Keep the late-loaded passage stylesheet in the cascade, as in the app.
import '../../styles/bioluminescent.css';

const units: UnitPreferences = {
    speed: 'kts',
    length: 'm',
    waveHeight: 'm',
    temp: 'C',
    distance: 'nm',
    visibility: 'nm',
};
const weather: WeatherMetrics = {
    windSpeed: 12,
    windGust: 18,
    windDirection: 'NE',
    windDegree: 45,
    waveHeight: 1.2,
    swellPeriod: 8,
    airTemperature: 24,
    description: 'Partly cloudy',
    condition: 'Partly Cloudy',
    uvIndex: 5,
    pressure: 1014,
    visibility: 10,
    humidity: 68,
    precipitation: 2,
};
// The offshore secondary grid uses these same labels and colors in HeroSlide.
const widgets: MetricWidget[] = [
    {
        id: 'water',
        label: 'WATER',
        icon: <ThermometerIcon />,
        headingColor: 'text-sky-400',
        labelColor: 'text-sky-300',
    },
    {
        id: 'drift',
        label: 'DRIFT',
        icon: <GaugeIcon />,
        headingColor: 'text-purple-400',
        labelColor: 'text-purple-300',
    },
    {
        id: 'set',
        label: 'SET',
        icon: <CompassIcon rotation={0} />,
        headingColor: 'text-purple-400',
        labelColor: 'text-purple-300',
    },
    { id: 'cape', label: 'CAPE', icon: <CloudIcon />, headingColor: 'text-amber-400', labelColor: 'text-amber-300' },
    { id: 'swell2', label: 'SWELL 2', icon: <WaveIcon />, headingColor: 'text-cyan-400', labelColor: 'text-cyan-300' },
    { id: 'period2', label: 'PER. 2', icon: <GaugeIcon />, headingColor: 'text-cyan-400', labelColor: 'text-cyan-300' },
];

function Fixture() {
    const [mode, setMode] = useState<'light' | 'dark' | 'night'>('light');
    useLayoutEffect(() => {
        document.documentElement.classList.toggle('display-light', mode === 'light');
    }, [mode]);
    return (
        <main className="min-h-screen bg-black text-white" data-testid="glass-background" data-mode={mode}>
            <nav className="flex gap-2 p-2" aria-label="Fixture display mode">
                {(['light', 'dark', 'night'] as const).map((value) => (
                    <button key={value} className="border border-white/20 p-2" onClick={() => setMode(value)}>
                        {value}
                    </button>
                ))}
            </nav>
            <div
                data-testid="glass-pane"
                style={{ width: '100%', maxWidth: 669, padding: 8 }}
                className="flex flex-col gap-3"
            >
                <CompactHeaderRow alerts={[]} moonPhase="🌔" />
                <CompactHeaderRow alerts={['GALE WARNING']} moonPhase="🌔" />
                <DndContext>
                    <HeroWidgets data={weather} units={units} locationType="coastal" />
                </DndContext>
                <section
                    data-testid="secondary-metrics"
                    className="relative w-full rounded-xl overflow-hidden bg-white/8 border border-white/15 flex flex-col"
                    style={{ height: 182 }}
                >
                    <MetricGridPanel widgets={widgets} getValue={() => '2'} getUnit={() => 'm'} />
                </section>
                <section
                    data-testid="daily-summary"
                    className="w-full bg-white/8 rounded-xl border border-white/15"
                    style={{ height: 300 }}
                >
                    <DailySummaryCard
                        units={units}
                        dateLabel="Thu 10 Sep"
                        daily={{
                            highTemp: 26,
                            lowTemp: 18,
                            condition: 'Partly Cloudy',
                            windSpeed: 12,
                            windGust: 18,
                            windDegree: 45,
                            waveHeight: 1.2,
                            swellPeriod: 8,
                            precipChance: 20,
                            tideSummary: 'High 08:00 · Low 14:00',
                        }}
                    />
                </section>
                <section data-testid="tide-card" className="bg-white/8 rounded-xl p-2" style={{ height: 180 }}>
                    <TideGraph
                        unit="m"
                        unitPref={units}
                        timeZone="UTC"
                        customTime={Date.parse('2026-09-10T05:00:00Z')}
                        stationPosition="bottom"
                        className="h-full"
                        tides={[
                            { time: '2026-09-10T02:00:00Z', height: 0.4, type: 'Low' },
                            { time: '2026-09-10T08:00:00Z', height: 2.2, type: 'High' },
                            { time: '2026-09-10T14:00:00Z', height: 0.5, type: 'Low' },
                            { time: '2026-09-10T20:00:00Z', height: 2.1, type: 'High' },
                        ]}
                    />
                </section>
            </div>
            {mode === 'night' && (
                <div
                    data-testid="night-scrim"
                    className="fixed inset-0 pointer-events-none touch-none"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: 9999 }}
                    aria-hidden="true"
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
