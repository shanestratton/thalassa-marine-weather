import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PassageDepartureModal } from '../../components/passage/PassageDepartureModal';
import type { PassageDepartureSuggestionState } from '../../services/passageDepartureSuggestion';
import '../../index.css';

function Fixture() {
    const [visible, setVisible] = useState(true);
    const [departureMs, setDepartureMs] = useState<number | null>(null);
    const [result, setResult] = useState('No departure confirmed');
    const [suggestion] = useState<PassageDepartureSuggestionState>(() => {
        const requested = new URLSearchParams(location.search).get('suggestion');
        if (requested === 'loading') return { status: 'loading' };
        if (requested === 'missing')
            return {
                status: 'unavailable',
                reason: 'coverage',
                message: 'Insufficient forecast coverage for the whole remaining passage and configured limits.',
            };
        const departure = Math.ceil((Date.now() + 24 * 3_600_000) / 3_600_000) * 3_600_000;
        return {
            status: 'ready',
            suggestion: {
                departureMs: departure,
                windowStartMs: departure,
                windowEndMs: departure + 3 * 3_600_000,
                windowDepartures: 4,
                approximateStart: true,
                uncheckedJoinNm: 0.02,
                modelLabel: 'ECMWF',
                cruiseKts: 6.2,
                durationMs: 5 * 3_600_000,
                maxWindKts: 12.4,
                maxGustKts: 18.1,
                maxWaveM: null,
                maxHeadwindKts: 4,
                gustComplete: true,
                waveComplete: false,
                windOnly: true,
                gustsRanked: true,
                spreadLevel: 'some',
                limits: { maxWindKts: 20, maxGustKts: 25 },
                sampleCount: 8,
                comparedDepartures: 37,
            },
        };
    });
    return (
        <main className="h-full overflow-y-auto bg-slate-900 p-6 text-white">
            <div className="mx-auto max-w-sm">
                <p className="text-xs uppercase tracking-widest text-teal-200">Local layout fixture</p>
                <h1 className="mt-3 text-2xl font-bold">Departure preview</h1>
                <p className="mt-2 text-sm text-slate-400">Synthetic route · no chart, GPS or network requests.</p>
                <button
                    type="button"
                    onClick={() => setVisible(true)}
                    className="mt-6 min-h-12 rounded-xl bg-teal-300 px-5 font-bold text-slate-950"
                >
                    Choose departure
                </button>
                <p role="status" className="mt-4 text-sm text-slate-300">
                    {result}
                </p>
            </div>
            <PassageDepartureModal
                visible={visible}
                departureMs={departureMs}
                onClose={() => setVisible(false)}
                onConfirm={(value) => {
                    setDepartureMs(value);
                    setResult(value === null ? 'Leave now' : `Departure: ${new Date(value).toLocaleString()}`);
                    setVisible(false);
                }}
                routeName="Newport → Mooloolaba"
                cruiseKts={6.2}
                suggestion={suggestion}
            />
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
