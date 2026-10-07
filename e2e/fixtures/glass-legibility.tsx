/** Real Glass components with deterministic data; no account or weather fetches. */
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { HeroWidgets } from '../../components/dashboard/HeroWidgets';
import { MetricGridPanel, type MetricWidget } from '../../components/dashboard/hero/MetricGridPanel';
import { DailySummaryCard } from '../../components/dashboard/hero/DailySummaryCard';
import { CompactHeaderRow } from '../../components/dashboard/CompactHeaderRow';
import { CurrentConditionsCard } from '../../components/dashboard/CurrentConditionsCard';
import { TideGraph } from '../../components/dashboard/tide/TideGraph';
import { ThermometerIcon, GaugeIcon, CompassIcon, CloudIcon, WaveIcon } from '../../components/Icons';
import type { UnitPreferences, WeatherMetrics } from '../../types';
import { SUN_STAYS_DOWN, SUN_STAYS_UP } from '../../utils/celestial';
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
// The widest readings each offshore tile draws, as HeroSlide formats them
// (W1-07, build 123): SWELL 2 in the skipper's own Seas unit, no arrow.
// ?seas=ft is the imperial skipper's grid.
const SEAS_FT = new URLSearchParams(window.location.search).get('seas') === 'ft';
const offshoreReadings: Record<string, [string, string]> = SEAS_FT
    ? {
          water: ['84', '°F'],
          drift: ['2.4', 'kts'],
          set: ['NNW', ''],
          cape: ['2400', ''],
          swell2: ['13.1', 'ft'],
          period2: ['16', 's'],
      }
    : {
          water: ['29', '°C'],
          drift: ['2.4', 'kts'],
          set: ['NNW', ''],
          cape: ['2400', ''],
          swell2: ['4.6', 'm'],
          period2: ['16', 's'],
      };

// ?daySlots=1 (2026-10-02): the day card in the Glass carousel's slot heights,
// measured in the app: 109 px at 375x667 (where it was cut off), 156 px at
// 375x800 and 197 px at 390x844. The card has to fit each without clipping.
const DAY_SLOTS = new URLSearchParams(window.location.search).get('daySlots') === '1' ? [109, 156, 197] : [];
// ?sun=polar (build 123, W1-06): the header's sun chip in polar day and night
// beside the '--:--' chip it stands in for, in the Glass header's px-4 gutter.
const POLAR_SUN = new URLSearchParams(window.location.search).get('sun') === 'polar';
const shortDay = {
    highTemp: 23,
    lowTemp: 21,
    condition: 'Light Drizzle',
    windSpeed: 12.5,
    windGust: 23.1,
    windDegree: 110,
    waveHeight: 2,
    swellPeriod: 8,
    precipChance: 40,
    tideSummary: 'High 08:12 · Low 14:30',
};

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
                {/* The compact conditions row with the readings that overran it
                    (Shane 2026-09-30: 'TRACE mm' ran into HUM), plus the inch
                    figures a Fahrenheit skipper sees. */}
                <section data-testid="conditions-trace-mm">
                    <CurrentConditionsCard data={{ ...weather, humidity: 100, precipitation: 0.1 }} units={units} />
                </section>
                <section data-testid="conditions-inch-small">
                    <CurrentConditionsCard
                        data={{ ...weather, humidity: 100, precipitation: 0.25 }}
                        units={{ ...units, temp: 'F' }}
                    />
                </section>
                <section data-testid="conditions-inch">
                    <CurrentConditionsCard
                        data={{ ...weather, humidity: 100, precipitation: 12.7 }}
                        units={{ ...units, temp: 'F' }}
                    />
                </section>
                <section
                    data-testid="secondary-metrics"
                    className="relative w-full rounded-xl overflow-hidden bg-white/8 border border-white/15 flex flex-col"
                    style={{ height: 182 }}
                >
                    <MetricGridPanel
                        widgets={widgets}
                        getValue={(id) => offshoreReadings[id][0]}
                        getUnit={(id) => offshoreReadings[id][1]}
                    />
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
                            // Two digits: '14s' is the widest period caption (W1-07).
                            swellPeriod: 14,
                            precipChance: 20,
                            tideSummary: 'High 08:00 · Low 14:00',
                        }}
                    />
                </section>
                {DAY_SLOTS.map((slot) => (
                    // Framed as HeroSlide frames it: a bordered, rounded,
                    // overflow-hidden box of the slot's height.
                    <section
                        key={slot}
                        data-testid={`day-slot-${slot}`}
                        className="relative w-full rounded-2xl overflow-hidden border border-white/8 bg-white/4"
                        style={{ height: slot }}
                    >
                        {/* As in the app: at 390x844 the day label row above the
                            carousel names the day, so the card draws no heading. */}
                        <DailySummaryCard
                            units={units}
                            dateLabel="Sat 3 Oct"
                            daily={shortDay}
                            showDateHeading={slot !== 197}
                        />
                    </section>
                ))}
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
            {POLAR_SUN && (
                <section data-testid="sun-chip-rows" className="w-full px-4 flex flex-col gap-3 pb-4">
                    {[
                        { id: 'pending', rise: undefined, set: undefined },
                        { id: 'up', rise: SUN_STAYS_UP, set: SUN_STAYS_UP },
                        { id: 'down', rise: SUN_STAYS_DOWN, set: SUN_STAYS_DOWN },
                    ].map((row) => (
                        <div key={row.id} data-testid={`sun-chip-${row.id}`}>
                            <CompactHeaderRow
                                alerts={[]}
                                sunrise={row.rise}
                                sunset={row.set}
                                moonPhase="🌔"
                                moonPhaseName="Waxing Gibbous"
                            />
                        </div>
                    ))}
                </section>
            )}
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
