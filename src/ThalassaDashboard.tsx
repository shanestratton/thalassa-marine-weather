import React, { useCallback, useEffect, useState } from 'react';

import TopNav from './components/TopNav';
import MapContainer from './components/MapContainer';
import DiarySidebar from './components/DiarySidebar';
import { PhotoLightbox, type PhotoLightboxMetadata } from './components/PhotoLightbox';
import { VoyageProgressBar } from './components/VoyageProgressBar';
import {
    fetchVoyageLog,
    parseVoyageLogParams,
    VoyageLogError,
    type VoyageLogData,
    type VoyageLogEntry,
} from './voyageLogApi';

// Re-fetch so followers-at-home see the live track crawl along without
// reloading. Matched to the device's ~2-minute live-trickle cadence so a
// moving boat updates about as fast as points are produced. The API caches
// for 60s, so the in-between polls are cheap cache hits.
const REFRESH_MS = 2 * 60 * 1000;

type LoadState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; data: VoyageLogData };

interface LightboxState {
    photos: string[];
    index: number;
    caption: string;
    metadata: PhotoLightboxMetadata;
}

const entryCaption = (e: VoyageLogEntry): string =>
    [e.title || 'Untitled', e.location_name].filter(Boolean).join(' · ');

const entryLightbox = (entry: VoyageLogEntry, index: number): LightboxState => ({
    photos: entry.photos,
    index,
    caption: entryCaption(entry),
    metadata: {
        capturedAt: entry.created_at,
        lat: entry.latitude,
        lon: entry.longitude,
        locationName: entry.location_name,
    },
});

export default function ThalassaDashboard() {
    const [state, setState] = useState<LoadState>({ status: 'loading' });
    // The entry currently in focus — drives the map fly-to AND the
    // sidebar's master/detail mode (null = show the full feed).
    const [selectedEntry, setSelectedEntry] = useState<VoyageLogEntry | null>(null);
    // Open photo lightbox, if any.
    const [lightbox, setLightbox] = useState<LightboxState | null>(null);
    // Diary folded away (Shane 2026-07-09: "hide the log entries with an
    // arrow"). Desktop: the sidebar collapses to a slim rail and the map
    // takes the full width. Mobile: the diary drops to a single reopen bar
    // and the map window grows. Survives the 2-min background refresh
    // because that setState never remounts this component.
    const [diaryHidden, setDiaryHidden] = useState(false);

    const load = useCallback(async (showSpinner: boolean) => {
        const { handle } = parseVoyageLogParams();
        if (!handle) {
            setState({
                status: 'error',
                message: 'This link is incomplete — it needs a vessel handle.',
            });
            return;
        }
        if (showSpinner) setState({ status: 'loading' });
        try {
            const data = await fetchVoyageLog(handle);
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

    // Selecting an entry flies the map there and opens its detail in the box.
    const handleSelect = useCallback((entry: VoyageLogEntry) => {
        setSelectedEntry(entry);
    }, []);

    const handleClear = useCallback(() => setSelectedEntry(null), []);

    // A photo tap: focus the entry (so the box shows its story) + open fullscreen.
    const handlePhoto = useCallback((entry: VoyageLogEntry, index: number) => {
        setSelectedEntry(entry);
        setLightbox(entryLightbox(entry, index));
    }, []);

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
    const {
        vessel,
        destination,
        entries,
        track,
        waypoints,
        telemetry,
        nearby_vessels: nearbyVessels,
        passage,
    } = state.data;

    return (
        // Desktop (md+): locked app-shell — full-height map + internally-
        // scrolling sidebar. Mobile: NATURAL PAGE SCROLL — the shell's
        // h-screen/overflow-hidden clipped everything below the fold and the
        // diary + photos were unreachable (Shane 2026-07-04). The map gets a
        // fixed 45dvh window; the diary flows below at full length.
        // EXCEPT when the diary is folded (Shane 2026-07-09 "make the map
        // expand to use all of that area"): with nothing below the fold to
        // reach, mobile flips into the same locked app-shell as desktop and
        // the map takes every pixel above the reopen bar.
        <div
            className={`flex flex-col ${
                diaryHidden ? 'h-[100dvh] overflow-hidden' : 'min-h-[100dvh]'
            } md:h-screen md:overflow-hidden bg-slate-900 text-slate-100 font-sans`}
        >
            <TopNav vessel={vessel} telemetry={telemetry} entryCount={entries.length} />
            <VoyageProgressBar track={track} destination={destination} />

            <div
                className={`relative flex flex-col md:flex-row md:flex-1 md:overflow-hidden ${
                    diaryHidden ? 'flex-1 min-h-0' : ''
                }`}
            >
                <main
                    className={`${
                        diaryHidden ? 'flex-1 min-h-0' : 'shrink-0 h-[45dvh] min-h-[280px]'
                    } md:shrink md:h-auto md:min-h-0 md:flex-1 bg-slate-950 relative`}
                >
                    <MapContainer
                        telemetry={telemetry}
                        track={track}
                        entries={entries}
                        passageLine={passage?.plan_line ?? null}
                        waypoints={waypoints ?? []}
                        nearbyVessels={nearbyVessels ?? []}
                        onEntryClick={handleSelect}
                        selectedEntryId={selectedEntry?.id}
                        // Fold/unfold changes the map's box — kick an
                        // explicit canvas resize so it fills the void.
                        resizeSignal={diaryHidden ? 1 : 0}
                    />
                </main>

                {/* Diary column: [toggle strip][diary]. The strip is a
                    horizontal bar on mobile (sits between map and diary)
                    and a slim full-height rail on desktop (sits on the
                    sidebar's map-side edge). Collapsing unmounts the diary
                    so the map keeps the whole row; the strip remains as
                    the reopen affordance. */}
                <aside className="w-full md:w-auto bg-slate-800 border-t md:border-t-0 md:border-l border-slate-700 flex flex-col md:flex-row z-10 shadow-xl">
                    <button
                        type="button"
                        onClick={() => setDiaryHidden((v) => !v)}
                        aria-expanded={!diaryHidden}
                        aria-label={diaryHidden ? 'Show log entries' : 'Hide log entries'}
                        title={diaryHidden ? 'Show log entries' : 'Hide log entries'}
                        className="shrink-0 flex items-center justify-center gap-2 w-full h-10 md:w-7 md:h-auto bg-slate-800 hover:bg-slate-700/70 active:bg-slate-700 md:border-r border-slate-700 text-slate-400 hover:text-sky-300 transition-colors"
                    >
                        <svg
                            className={`w-4 h-4 transition-transform duration-300 ${
                                diaryHidden ? 'md:rotate-90' : 'rotate-180 md:-rotate-90'
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                        <span className="text-[10px] font-bold uppercase tracking-widest md:hidden">
                            {diaryHidden ? `Show log entries (${entries.length})` : 'Hide log entries'}
                        </span>
                    </button>
                    {!diaryHidden && (
                        <div className="w-full md:w-96 flex flex-col min-h-0 md:h-full">
                            <DiarySidebar
                                entries={entries}
                                telemetry={telemetry}
                                selectedEntry={selectedEntry}
                                onSelectEntry={handleSelect}
                                onClearSelection={handleClear}
                                onPhotoClick={handlePhoto}
                            />
                        </div>
                    )}
                </aside>
            </div>

            {lightbox && (
                <PhotoLightbox
                    photos={lightbox.photos}
                    startIndex={lightbox.index}
                    caption={lightbox.caption}
                    metadata={lightbox.metadata}
                    onClose={() => setLightbox(null)}
                />
            )}
        </div>
    );
}
