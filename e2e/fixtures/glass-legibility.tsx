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
import { SunMoonSheet } from '../../components/dashboard/SunMoonSheet';
import type { DayAgreementChip } from '../../components/dashboard/hero/DailySummaryCard';
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
// ?w109=<device> (build 123, W1-09): the day card with the models' agreement
// chip and its sun & moon row, in the carousel slot that phone gives it, at
// the app's 16 px gutters. 197 px at 390x844 and 109 px at 375x667 were
// measured in the app (2026-10-02); the others follow from the Glass stack
// (glassLayout.ts) and each phone's insets: 393x852 (59/34) 193, 430x932
// (59/34) 273, 375x812 (50/34) 162, 320x693 zoomed (48/28) 79.
// &fonts=wide draws Verdana / DejaVu Sans, the widest faces we meet.
const PARAMS = new URLSearchParams(window.location.search);
const W109_SLOTS: Record<string, { slot: number; dayLabel: boolean }> = {
    'iphone-15': { slot: 193, dayLabel: true },
    'iphone-pro-max': { slot: 273, dayLabel: true },
    'iphone-13-mini': { slot: 162, dayLabel: true },
    'iphone-se': { slot: 109, dayLabel: false },
    'iphone-16-zoomed': { slot: 79, dayLabel: false },
};
const W109 = W109_SLOTS[PARAMS.get('w109') ?? ''];
// ?sunmoon=1&top=<px>&bottom=<px>: the header chip as the sheet's button and
// the sheet open over the app's tab bar, the phone's insets painted where
// env() would put them (env() is 0 in a desktop browser).
const SUN_MOON = PARAMS.get('sunmoon') === '1';
const INSET_TOP = Math.max(0, Number(PARAMS.get('top')) || 0);
const INSET_BOTTOM = Math.max(0, Number(PARAMS.get('bottom')) || 0);
if (PARAMS.get('fonts') === 'wide') {
    const wide = document.createElement('style');
    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
    document.head.append(wide);
}
if (SUN_MOON) {
    const insets = document.createElement('style');
    insets.textContent = `[role="presentation"]:has(> [aria-labelledby="sun-moon-title"]) { padding-top: max(1rem, ${INSET_TOP}px) !important; padding-bottom: calc(4rem + ${INSET_BOTTOM}px + 1rem) !important; }`;
    document.head.append(insets);
}
/** Fictional: Airlie Beach's USNO times for 7 Oct 2026. */
const W109_SKY = {
    firstLight: '05:19',
    sunrise: '05:42',
    sunset: '18:05',
    lastLight: '18:27',
    moonrise: '03:13',
    moonset: '14:57',
    illumination: 0.12,
    phaseName: 'Waning Crescent',
};
/** The card as the app draws it (no tide line: nothing fills tideSummary
 *  today), a long condition with the widest chip, and the worst case with a
 *  tide line too. */
const W109_CARDS: { id: string; tide: boolean; condition: string; agreement: DayAgreementChip }[] = [
    {
        id: 'app',
        tide: false,
        condition: 'Partly Cloudy',
        agreement: { level: 'some', members: 7, peak: 7, thin: false },
    },
    {
        id: 'thin',
        tide: false,
        condition: 'Thunderstorm with slight hail',
        agreement: { level: 'split', members: 4, peak: 7, thin: true },
    },
    {
        id: 'tide',
        tide: true,
        condition: 'Light Drizzle',
        agreement: { level: 'agree', members: 7, peak: 7, thin: false },
    },
];

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
            {W109 && (
                <section data-testid="w109-cards" className="w-full px-4 flex flex-col gap-3 pb-4">
                    {W109_CARDS.filter((c) => !c.tide || W109.slot > 100).map((card) => (
                        // Framed as HeroSlide frames it.
                        <div
                            key={card.id}
                            data-testid={`w109-${card.id}`}
                            className="relative w-full rounded-2xl overflow-hidden border border-white/8 bg-white/4"
                            style={{ height: W109.slot }}
                        >
                            <DailySummaryCard
                                units={units}
                                dateLabel="Sat 10 Oct"
                                showDateHeading={!W109.dayLabel}
                                daily={{
                                    ...shortDay,
                                    swellPeriod: 14,
                                    condition: card.condition,
                                    tideSummary: card.tide ? shortDay.tideSummary : undefined,
                                }}
                                agreement={card.agreement}
                                onCompare={() => undefined}
                                sky={W109_SKY}
                            />
                        </div>
                    ))}
                </section>
            )}
            {SUN_MOON && (
                <>
                    <section data-testid="sun-moon-chip" className="w-full px-4 pb-4">
                        <CompactHeaderRow
                            alerts={[]}
                            sunrise="07:43"
                            sunset="19:09"
                            moonPhase="🌘"
                            moonPhaseName="Waning Crescent"
                            onOpenSunMoon={() => undefined}
                        />
                    </section>
                    {/* Marseille's own day, fictional position nearby. */}
                    <SunMoonSheet
                        onClose={() => undefined}
                        lat={43.3}
                        lon={5.37}
                        timeZone="Europe/Paris"
                        isoDate="2026-10-07"
                        isToday={false}
                    />
                    {/* The real tab bar's geometry (App.tsx): fixed, z-900, 4rem above the home indicator. */}
                    <nav
                        aria-label="Main"
                        className="fixed bottom-0 left-0 right-0 z-900 border-t"
                        style={{
                            background: 'rgb(10, 15, 20)',
                            borderColor: 'rgba(56, 189, 248, 0.12)',
                            paddingBottom: INSET_BOTTOM,
                        }}
                    >
                        <div className="mx-auto flex h-16 items-center justify-around px-4 text-xs font-bold text-slate-300">
                            <span className="text-sky-300">THE GLASS</span>
                            <span>OBS</span>
                            <span>PLAN</span>
                            <span>VESSEL</span>
                        </div>
                    </nav>
                </>
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
