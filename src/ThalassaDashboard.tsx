import React, { useCallback, useEffect, useState } from 'react';

import TopNav from './components/TopNav';
import MapContainer from './components/MapContainer';
import DiarySidebar from './components/DiarySidebar';
import {
    fetchVoyageLog,
    parseVoyageLogParams,
    VoyageLogError,
    type VoyageLogData,
    type VoyageLogEntry,
} from './voyageLogApi';

// Re-fetch every 5 minutes so followers-at-home see new entries / position
// without reloading. The API caches for 60s, so this is cheap.
const REFRESH_MS = 5 * 60 * 1000;

type LoadState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; data: VoyageLogData };

export default function ThalassaDashboard() {
    const [state, setState] = useState<LoadState>({ status: 'loading' });
    // Entry the viewer tapped in the sidebar — the map flies to it.
    const [focusEntry, setFocusEntry] = useState<VoyageLogEntry | null>(null);

    const load = useCallback(async (showSpinner: boolean) => {
        const { handle, key } = parseVoyageLogParams();
        if (!handle || !key) {
            setState({
                status: 'error',
                message: 'This link is incomplete — it needs a vessel handle and key.',
            });
            return;
        }
        if (showSpinner) setState({ status: 'loading' });
        try {
            const data = await fetchVoyageLog(handle, key);
            setState({ status: 'ready', data });
        } catch (e) {
            const message = e instanceof VoyageLogError ? e.message : 'Something went wrong loading this voyage log.';
            // Don't blow away good data on a failed background refresh.
            setState((prev) => (prev.status === 'ready' && !showSpinner ? prev : { status: 'error', message }));
        }
    }, []);

    useEffect(() => {
        void load(true);
        const id = setInterval(() => void load(false), REFRESH_MS);
        return () => clearInterval(id);
    }, [load]);

    // ── Loading ───────────────────────────────────────────────────
    if (state.status === 'loading') {
        return (
            <div className="flex flex-col items-center justify-center h-screen bg-slate-900 text-slate-300 gap-4">
                <div className="w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-bold uppercase tracking-widest text-slate-500">Loading voyage log…</p>
            </div>
        );
    }

    // ── Error ─────────────────────────────────────────────────────
    if (state.status === 'error') {
        return (
            <div className="flex flex-col items-center justify-center h-screen bg-slate-900 text-slate-300 gap-3 px-8 text-center">
                <span className="text-4xl">🧭</span>
                <h1 className="text-xl font-bold text-white">Voyage Log unavailable</h1>
                <p className="text-sm text-slate-400 max-w-sm">{state.message}</p>
            </div>
        );
    }

    // ── Ready ─────────────────────────────────────────────────────
    const { vessel, entries, track, telemetry } = state.data;

    return (
        <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden font-sans">
            <TopNav vessel={vessel} telemetry={telemetry} />

            <div className="flex flex-1 overflow-hidden relative flex-col md:flex-row">
                <main className="flex-1 bg-slate-950 relative min-h-[40vh]">
                    <MapContainer track={track} entries={entries} focusEntry={focusEntry} />
                </main>

                <aside className="w-full md:w-96 bg-slate-800 border-t md:border-t-0 md:border-l border-slate-700 flex flex-col z-10 shadow-xl">
                    <DiarySidebar entries={entries} onEntryClick={setFocusEntry} />
                </aside>
            </div>
        </div>
    );
}
