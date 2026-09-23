import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GpsDiagnosticsCards } from '../../components/GpsDiagnosticsCards';
import { presentGpsDiagnostics } from '../../components/gpsDiagnosticsPresentation';
import '../../index.css';

type Scenario = 'fresh' | 'stale' | 'missing';
const requested = new URLSearchParams(location.search).get('state');
const initial: Scenario = requested === 'stale' || requested === 'missing' ? requested : 'fresh';

function Fixture() {
    const [scenario, setScenario] = useState<Scenario>(initial);
    const now = Date.now();
    const timestamp = now - (scenario === 'stale' ? 45_000 : 0);
    const metric = (value: number) => (scenario === 'missing' ? null : { value, timestamp });
    const sources = [
        presentGpsDiagnostics(
            {
                label: 'Boat GPS · Pi LAN',
                maxAgeMs: 13_000,
                positionAt: scenario === 'missing' ? null : now,
                satellites: metric(32),
                fixQuality: metric(2),
                hdop: metric(0.47),
                accuracyM: null,
            },
            now,
        ),
        presentGpsDiagnostics(
            {
                label: 'Phone location',
                phone: true,
                maxAgeMs: 30_000,
                positionAt: scenario === 'missing' ? null : timestamp,
                accuracyM: metric(4.2),
            },
            now,
        ),
    ];
    return (
        <main className="h-full overflow-y-auto bg-slate-950 p-4 text-white">
            <div className="mx-auto w-full max-w-[390px]">
                <h1 className="text-xl font-bold">GPS diagnostics preview</h1>
                <p className="mt-1 mb-4 text-xs text-slate-400">Synthetic data · no GPS or network requests</p>
                <div className="mb-4 flex flex-wrap gap-2" aria-label="Fixture scenarios">
                    {(['fresh', 'stale', 'missing'] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={scenario === value}
                            className={`min-h-11 rounded-xl px-4 text-sm font-semibold ${scenario === value ? 'bg-sky-600' : 'bg-slate-800'}`}
                            onClick={() => setScenario(value)}
                        >
                            {value === 'fresh' ? 'Fresh' : value === 'stale' ? 'Stale' : 'Missing'}
                        </button>
                    ))}
                </div>
                <div className="rounded-2xl border border-white/15 bg-slate-900/95 p-5">
                    <h2 className="mb-4 text-base font-bold">System Status</h2>
                    <GpsDiagnosticsCards sources={sources} />
                </div>
            </div>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
