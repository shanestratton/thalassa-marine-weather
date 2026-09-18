import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SailPlanDiagram } from '../../components/nmea/gauges/SailPlanDiagram';
import { SailPartsDiagram } from '../../components/nmea/gauges/SailPartsDiagram';
import { NIGHT_SCRIM_Z_INDEX } from '../../components/ui/OverlayPortal';
import { TRIM } from '../../services/sailing/sereneSailing';
import '../../index.css';

// Pure visual fixture: no account, telemetry, GPS, storage or backend service.
const params = new URLSearchParams(location.search);
const bands = ['Beating', 'Close reach', 'Beam reach', 'Broad reach', 'Running', 'Unknown'];
const angles: Record<string, number> = {
    Beating: 45,
    'Close reach': 65,
    'Beam reach': 90,
    'Broad reach': 130,
    Running: 165,
};
function Fixture() {
    const [band, setBand] = useState(params.get('band') ?? 'Beam reach');
    const [tack, setTack] = useState(params.get('tack') ?? 'starboard');
    const [mode, setMode] = useState(params.get('mode') ?? 'dark');
    const [stowed, setStowed] = useState(params.get('stowed') === 'true');
    const [gybe, setGybe] = useState(params.get('gybe') === 'true');
    const pane = params.get('pane') === 'true';
    const magnitude = angles[band] ?? 90;
    const windAngle = tack === 'unknown' ? null : tack === 'port' ? 360 - magnitude : magnitude;
    const advice = TRIM[band as keyof typeof TRIM];
    useLayoutEffect(() => {
        document.documentElement.classList.toggle('display-light', mode === 'light');
    }, [mode]);
    return (
        <main className="h-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            {mode === 'night' && (
                <div
                    data-testid="night-scrim"
                    className="pointer-events-none fixed inset-0"
                    aria-hidden="true"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                />
            )}
            {pane && <aside className="absolute inset-y-0 left-0 w-1/2 bg-slate-900 p-4">Other tablet pane</aside>}
            <section
                className={`relative h-full overflow-y-auto ${pane ? 'ml-auto w-1/2' : 'w-full'}`}
                data-testid="sail-plan-pane"
                data-split-pane={pane ? 'instruments' : undefined}
            >
                <div className="p-3">
                    <h1 className="text-lg font-bold">Sail plan</h1>
                    <div className="my-3 grid grid-cols-2 gap-2 text-sm" aria-label="Fixture controls">
                        <label>
                            Band
                            <select
                                aria-label="Band"
                                className="block w-full bg-slate-800 p-2"
                                value={band}
                                onChange={(event) => setBand(event.target.value)}
                            >
                                {bands.map((value) => (
                                    <option key={value}>{value}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Wind side
                            <select
                                aria-label="Wind side"
                                className="block w-full bg-slate-800 p-2"
                                value={tack}
                                onChange={(event) => setTack(event.target.value)}
                            >
                                {['starboard', 'port', 'unknown'].map((value) => (
                                    <option key={value}>{value}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Display
                            <select
                                aria-label="Display"
                                className="block w-full bg-slate-800 p-2"
                                value={mode}
                                onChange={(event) => setMode(event.target.value)}
                            >
                                {['light', 'dark', 'night'].map((value) => (
                                    <option key={value}>{value}</option>
                                ))}
                            </select>
                        </label>
                        <div className="flex flex-col justify-center gap-1">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={stowed}
                                    onChange={(event) => setStowed(event.target.checked)}
                                />{' '}
                                Sails stowed
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={gybe}
                                    onChange={(event) => setGybe(event.target.checked)}
                                />{' '}
                                Gybe down
                            </label>
                        </div>
                    </div>
                    <details
                        open
                        className="rounded-2xl border border-white/6 bg-white/3 p-3"
                        data-testid="sail-plan-details"
                        data-band={band}
                        data-tack={tack}
                    >
                        <summary className="text-[11px] font-black uppercase tracking-[0.2em] text-gray-400">
                            Where everything goes
                        </summary>
                        <SailPlanDiagram
                            band={band === 'Running' && gybe ? 'Broad reach' : band}
                            adviceBand={band}
                            windAngle={windAngle}
                            main={stowed ? 'Down' : 'Full'}
                            yankee={stowed ? 'Furled' : 'Full'}
                            stay={!stowed}
                            prevent
                            runners
                            className="mx-auto mt-2 block h-auto w-full max-w-[420px]"
                        />
                        <details
                            className="mt-2 rounded-xl border border-white/6 bg-white/2 p-2"
                            data-testid="following-parts"
                        >
                            <summary className="text-[10px] font-black uppercase tracking-[0.18em] text-gray-500">
                                Parts of a sail
                            </summary>
                            <SailPartsDiagram className="mx-auto mt-2 block h-auto w-full max-w-[420px]" />
                        </details>
                        <div
                            className="mt-2 space-y-2 text-[12px] leading-relaxed text-gray-300"
                            data-testid="trim-prose"
                        >
                            {advice ? (
                                Object.entries(advice).map(([name, text]) => (
                                    <p key={name}>
                                        <b className="text-white">{name}.</b> {text}
                                    </p>
                                ))
                            ) : (
                                <p>No trim recommendation for an unknown band.</p>
                            )}
                        </div>
                    </details>
                </div>
            </section>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
