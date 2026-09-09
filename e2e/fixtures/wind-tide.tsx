/** Real tide faces in a constrained Glass-sized card; no account or network. */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WindVsTideView } from '../../components/dashboard/tide/WindVsTideView';
import { TideGraph } from '../../components/dashboard/tide/TideGraph';
import type { Tide, TidePoint, UnitPreferences } from '../../types';
import '../../index.css';
import '../../styles/bioluminescent.css';

const nowMs = Date.parse('2026-09-09T02:30:00Z');
const units: UnitPreferences = {
    speed: 'kts',
    temp: 'C',
    distance: 'nm',
    length: 'm',
    waveHeight: 'm',
    tideHeight: 'm',
};
const tides: Tide[] = [
    { time: '2026-09-09T00:00:00Z', height: 0.4, type: 'Low' },
    { time: '2026-09-09T06:00:00Z', height: 2, type: 'High' },
    { time: '2026-09-09T12:00:00Z', height: 0.4, type: 'Low' },
    { time: '2026-09-09T18:00:00Z', height: 2, type: 'High' },
];
const tideSeries: TidePoint[] = tides.map(({ time, height }) => ({ time, height }));

function Fixture() {
    const params = new URLSearchParams(location.search);
    const height = Number(params.get('height') || 180);
    const split = params.has('split');
    const mode = params.get('mode') || 'light';
    const samples: Record<string, React.ComponentProps<typeof WindVsTideView>['now']> = {
        default: { windDeg: 45, windKts: 6, currentDir: 0, currentKts: 0 },
        measured: { windDeg: 45, windKts: 18, currentDir: 45, currentKts: 1.5 },
        inferred: { windDeg: 45, windKts: 18, currentDir: 45 },
        unknown: { windDeg: 45, windKts: 15, currentDir: 45 },
        missing: {},
        with: { windDeg: 225, windKts: 6, currentDir: 45, currentKts: 0 },
    };
    const sample = samples[params.get('scenario') || 'default'];
    const [open, setOpen] = useState(false);
    const [flood, setFlood] = useState<number | undefined>(params.has('customFlood') ? 345 : undefined);
    const [escapedKeys, setEscapedKeys] = useState(0);
    const cardRef = useRef<HTMLDivElement>(null);
    const pendingFocus = useRef<'details' | 'graph' | null>(null);
    useLayoutEffect(() => {
        document.documentElement.classList.toggle('display-light', mode === 'light');
    }, [mode]);
    useLayoutEffect(() => {
        if (pendingFocus.current === 'details') {
            cardRef.current?.querySelector<HTMLElement>('[role="region"]')?.focus({ preventScroll: true });
        } else if (pendingFocus.current === 'graph') {
            cardRef.current?.focus({ preventScroll: true });
        }
        pendingFocus.current = null;
    }, [open]);

    return (
        <main className="min-h-screen bg-slate-950 text-white p-3">
            <div className={split ? 'grid grid-cols-2 gap-3' : ''}>
                <section className="min-w-0">
                    <div data-testid="summary" className="rounded-xl bg-white/8 p-3 mb-2">
                        Scarborough · 22°C · Wind NE 6 kts
                    </div>
                    <div
                        data-testid="daily-carousel"
                        className="overflow-y-auto snap-y snap-mandatory"
                        style={{ height }}
                        onKeyDown={(event) => {
                            if (
                                event.key.startsWith('Arrow') ||
                                ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)
                            ) {
                                event.preventDefault();
                                setEscapedKeys((value) => value + 1);
                            }
                        }}
                    >
                        <div className="h-full snap-start shrink-0">
                            <div
                                data-testid="hourly-carousel"
                                className="h-full flex overflow-x-auto snap-x snap-mandatory"
                            >
                                <div className="h-full w-full shrink-0 snap-start">
                                    <div
                                        ref={cardRef}
                                        data-testid="tide-card"
                                        className="relative h-full w-full min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-white/4"
                                        role={open ? undefined : 'button'}
                                        tabIndex={open ? undefined : 0}
                                        aria-label={open ? undefined : 'Show wind versus tide'}
                                        onClick={open ? undefined : () => setOpen(true)}
                                        onKeyDown={(event) => {
                                            if (!open && (event.key === 'Enter' || event.key === ' ')) {
                                                event.preventDefault();
                                                pendingFocus.current = 'details';
                                                setOpen(true);
                                            }
                                        }}
                                    >
                                        {open ? (
                                            <WindVsTideView
                                                tideSeries={tideSeries}
                                                now={sample}
                                                nowMs={nowMs}
                                                units={units}
                                                floodDirection={flood}
                                                onSetFloodDirection={setFlood}
                                                onClose={(event) => {
                                                    pendingFocus.current = event.detail === 0 ? 'graph' : null;
                                                    setOpen(false);
                                                }}
                                            />
                                        ) : (
                                            <TideGraph
                                                tides={tides}
                                                tideSeries={tideSeries}
                                                customTime={nowMs}
                                                timeZone="Australia/Brisbane"
                                                unit="m"
                                                unitPref={units}
                                                className="h-full w-full"
                                            />
                                        )}
                                    </div>
                                </div>
                                <div className="h-full w-full shrink-0 snap-start">Next hour</div>
                            </div>
                        </div>
                        <div className="h-full snap-start shrink-0">Next day</div>
                    </div>
                    <div data-testid="model-strip" className="mt-2 p-3 rounded-xl bg-white/8">
                        Inshore · ECMWF
                    </div>
                    <output data-testid="escaped-keys">{escapedKeys}</output>
                </section>
                {split && (
                    <aside data-testid="other-pane" className="bg-white/8 rounded-xl p-4">
                        Other pane stays put
                    </aside>
                )}
            </div>
            {mode === 'night' && (
                <div
                    className="fixed inset-0 pointer-events-none"
                    style={{ backgroundColor: 'rgba(69,10,10,0.25)', zIndex: 9999 }}
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
