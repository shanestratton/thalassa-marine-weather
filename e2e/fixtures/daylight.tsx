/** Isolated real-CSS checks: no account, backend, charts or vessel connections. */
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
// Passage styles load after the app in normal use; day tokens must still win.
import '../../styles/bioluminescent.css';

function Fixture() {
    const [light, setLight] = useState(true);
    useLayoutEffect(() => {
        document.documentElement.classList.toggle('display-light', light);
    }, [light]);
    return (
        <main className="min-h-screen bg-slate-950 p-4 text-white">
            <button className="mb-4 rounded-lg border border-white/20 p-3" onClick={() => setLight(!light)}>
                Toggle day
            </button>
            <section data-testid="neutral-card" className="mb-4 rounded-xl bg-slate-800 p-4">
                <h1 className="text-white">Daylight legibility</h1>
                {[
                    'text-gray-300',
                    'text-gray-400',
                    'text-slate-400',
                    'text-white/40',
                    'text-white/60',
                    'text-sky-300',
                    'text-emerald-400',
                    'text-amber-400',
                    'text-red-200',
                ].map((color) => (
                    <p key={color} className={color} data-contrast>
                        {color} — vessel information
                    </p>
                ))}
                <label className="block text-slate-200">
                    Vessel name
                    <input
                        className="block rounded-lg border border-white/20 bg-slate-900 p-3"
                        placeholder="Enter a name"
                    />
                </label>
                <button data-testid="filled-cta" className="mt-3 rounded-lg bg-sky-600 p-3 text-white">
                    Save changes
                </button>
            </section>
            <section data-testid="dense-card" className="mb-4 rounded-xl bg-slate-950/80 p-4">
                Dense map tool surface
            </section>
            <section
                data-testid="gradient-card"
                className="mb-4 rounded-xl bg-linear-to-b from-slate-950 via-slate-900 to-slate-950 p-4"
            >
                Gradient surface
            </section>
            <section data-testid="passage-card" className="glass-panel glass-panel--dense p-4">
                <h2 className="bio-header">Passage</h2>
                <p className="bio-label">Departure</p>
                <p className="bio-data">12:00</p>
                <p className="bio-data--warning">Wind caution</p>
                <p className="bio-data--danger">Route warning</p>
            </section>
            {['seamark-popup', 'mpa-popup', 'ntm-popup', 'tide-station-popup'].map((kind) => (
                <section key={kind} className={kind} data-testid={kind}>
                    <div className="mapboxgl-popup-content">
                        <p style={{ color: 'var(--day-ui-text, #e2e8f0)' }}>Feature information</p>
                    </div>
                </section>
            ))}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
