import React from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { HeroWidgets } from '../../components/dashboard/HeroWidgets';
import PrivateComfortSection from '../../components/settings/PrivateComfortSection';
import type { HourlyForecast, WeatherMetrics } from '../../types';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const params = new URLSearchParams(location.search),
    unknown = params.get('unknown') === '1';
document.documentElement.style.fontSize = params.get('large') === '1' ? '20.8px' : '16px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
const now = Date.now(),
    part = { hM: 1.2, periodS: 8, fromDeg: 90 };
const data: WeatherMetrics = {
    windSpeed: 12,
    windGust: 16,
    windDirection: 'SE',
    waveHeight: unknown ? null : 1.2 / 0.3048,
    swellPeriod: unknown ? null : 8,
    swellDirection: unknown ? undefined : 'E',
    airTemperature: 22,
    waterTemperature: 24,
    humidity: 75,
    pressure: 1015,
    visibility: 10,
    uvIndex: 3,
    precipitation: 0,
    description: 'Fictional',
    condition: 'Cloudy',
    marine: {
        status: unknown ? 'unavailable' : 'available',
        reason: unknown ? 'No local wave model reaches this fictional berth.' : null,
        waveModel: 'meteofrance_wave',
        motionModel: 'best_match',
        fetchedAtMs: now,
        waveValidAtMs: now,
        motionValidAtMs: now,
        requested: { latitude: -27, longitude: 153 },
        parts: {
            total: unknown ? null : part,
            windSea: unknown ? null : { hM: 0.6, periodS: 4, fromDeg: 0 },
            swell: unknown ? null : { hM: 1, periodS: 8, fromDeg: 90 },
            secondarySwell: unknown ? null : { hM: 0.3, periodS: 10, fromDeg: 180 },
        },
    },
};
const Widgets = HeroWidgets;
const hours: HourlyForecast[] = Array.from({ length: 4 }, (_, n) => ({
    time: new Date(now + n * 3600000).toISOString(),
    windSpeed: 12,
    waveHeight: data.waveHeight,
    temperature: 22,
    condition: 'Cloudy',
    marine: { ...data.marine!, waveValidAtMs: now + n * 3600000 },
}));
function Fixture() {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    );
    return (
        <main className="h-full overflow-hidden bg-slate-950 p-3 text-white">
            <p className="mb-2 text-xs">Fictional layout data · network disabled</p>
            <PrivateComfortSection />
            <div className="mt-3" data-glass-fixture>
                <DndContext sensors={sensors}>
                    <Widgets
                        data={data}
                        units={{ speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' }}
                        isLive
                        locationType="offshore"
                        hourly={hours}
                        forecast={[]}
                    />
                </DndContext>
            </div>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
