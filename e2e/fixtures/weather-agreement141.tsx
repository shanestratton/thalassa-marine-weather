/** Actual fixed-height card + pure verdict; synthetic data, no providers. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DailySummaryCard } from '../../components/dashboard/hero/DailySummaryCard';
import { weatherAgreementByDay } from '../../services/weather/dayAgreement';
import type { ModelSpreadResult } from '../../services/weather/ModelSpreadService';
import '../../index.css';
import '../../styles/bioluminescent.css';

const params = new URLSearchParams(location.search);
if (params.get('scale') === '130') document.documentElement.style.fontSize = '130%';
const times = Array.from({ length: 72 }, (_, i) => Date.UTC(2026, 9, 17) + i * 3_600_000);
const kind = params.get('kind') === 'rain' ? 'rain' : 'wave';
const input: ModelSpreadResult = {
    atmos: {
        times,
        models: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
            id: `atmos${i}`,
            label: `Atmos ${i}`,
            provider: 'Fixture',
            hex: '#fff',
            values: {
                wind_speed_10m: times.map(() => 12),
                wind_direction_10m: times.map(() => 200),
                precipitation: times.map(() => (kind === 'rain' && i === 0 ? 3 : 0)),
            } as never,
        })),
    },
    marine: {
        times,
        models: [0, 1, 2, 3].map((i) => ({
            id: `wave${i}`,
            label: `Wave ${i}`,
            provider: 'Fixture',
            hex: '#fff',
            values: {
                wave_height: times.map(() => (kind === 'wave' && i === 0 ? 3 : 1)),
                wave_period: times.map(() => 8),
            },
        })),
    },
};
const verdict = weatherAgreementByDay(input, 'UTC')[1];
declare global {
    interface Window {
        __weatherAgreement141: { clicks: number; driver: string | null };
    }
}
window.__weatherAgreement141 = { clicks: 0, driver: verdict.driver };
createRoot(document.getElementById('root')!).render(
    <main
        style={{
            height: '100dvh',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            background: '#020617',
        }}
    >
        <p style={{ height: 24, flex: 'none', fontSize: 12, color: '#fff' }}>Synthetic {kind} disagreement</p>
        {[109, 156, 230].map((height) => (
            <section
                key={height}
                data-testid={`weather-card-${height}`}
                style={{ height, flex: 'none', border: '1px solid #334155', borderRadius: 12, overflow: 'hidden' }}
            >
                <DailySummaryCard
                    units={{ speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' }}
                    daily={{
                        highTemp: 26,
                        lowTemp: 18,
                        condition: 'Partly Cloudy',
                        windSpeed: 12,
                        windGust: 18,
                        windDegree: 45,
                        waveHeight: 1.2,
                        swellPeriod: 14,
                        precipChance: 40,
                        tideSummary: 'High 08:12 · Low 14:30',
                    }}
                    dateLabel="Sun 18 Oct"
                    showDateHeading={false}
                    agreement={verdict}
                    onCompare={() => {
                        window.__weatherAgreement141.clicks++;
                    }}
                />
            </section>
        ))}
    </main>,
);
