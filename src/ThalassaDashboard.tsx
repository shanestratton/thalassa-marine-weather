import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import TopNav from './components/TopNav';
import MapContainer from './components/MapContainer';
import DiarySidebar from './components/DiarySidebar';
import type { PhotoLightboxMetadata } from './components/PhotoLightbox';
import { VoyageProgressBar } from './components/VoyageProgressBar';
import {
    fetchVoyageLog,
    parseVoyageLogParams,
    VoyageLogError,
    type VoyageLogData,
    type VoyageLogEntry,
    type VoyageLogWaypoint,
    type NearbyVessel,
    type PublicVoyageTrip,
} from './voyageLogApi';
import { PUBLIC_POSITION_FRESH_MS } from './publicVoyageFreshness';

// The lightbox (and the 74 KB tz-lookup chunk it drags in) is only needed
// after a photo tap — keep it off the page's critical path.
const PhotoLightbox = React.lazy(() =>
    import('./components/PhotoLightbox').then((m) => ({ default: m.PhotoLightbox })),
);

// Stable empties: a fresh `[]` literal per render is a new prop identity, which
// re-reconciled the whole Mapbox tree on every 30 s clock tick.
const EMPTY_WAYPOINTS: VoyageLogWaypoint[] = [];
const NO_VESSELS: NearbyVessel[] = [];

// The latest view should notice a newly trickled track on the next cache
// turn. A deliberately selected historical trip has no live motion to chase,
// so it refreshes less often while retaining its stable selection.
const LATEST_REFRESH_MS = 60 * 1000;
/** How recent the boat's last fix must be for "traffic around it" to still
 *  describe anything real. Six hours covers a lunch stop or a night at anchor
 *  without reaching back to a passage that is over. */
const AIS_POSITION_FRESH_MS = 6 * 3_600_000;
const HISTORY_REFRESH_MS = 2 * 60 * 1000;
const DASHBOARD_CLOCK_MS = 30 * 1000;

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

const tripOptionLabel = (trip: PublicVoyageTrip): string => {
    const distance = trip.distance_nm != null && trip.distance_nm > 0 ? ` · ${trip.distance_nm.toFixed(1)} nm` : '';
    const route = trip.has_route ? ' · route' : '';
    return `${trip.label}${distance}${route}`;
};

export default function ThalassaDashboard() {
    const [state, setState] = useState<LoadState>({ status: 'loading' });
    // "latest" is intentionally a mode rather than the current trip id. It
    // keeps following the skipper into a newly-started voyage, while picking
    // an id below freezes that historical view through background refreshes.
    const [requestedTrip, setRequestedTrip] = useState('latest');
    const [isTripLoading, setIsTripLoading] = useState(false);
    const [lastSuccessfulAt, setLastSuccessfulAt] = useState<number | null>(null);
    const [pollFailed, setPollFailed] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const requestSequence = useRef(0);
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

    const load = useCallback(async (showSpinner: boolean, trip: string) => {
        // Polls and picker changes can overlap on a slow satellite link. Only
        // the newest request is allowed to paint the page — otherwise an old
        // "latest" result can overwrite a deliberate historical selection.
        const requestId = ++requestSequence.current;
        const { handle } = parseVoyageLogParams();
        if (!handle) {
            if (requestId === requestSequence.current) {
                setState({
                    status: 'error',
                    message: 'This link is incomplete — it needs a vessel handle.',
                });
                setIsTripLoading(false);
            }
            return;
        }
        if (showSpinner) {
            setIsTripLoading(true);
            // Keep an already-rendered voyage visible while a picker change
            // resolves. The compact spinner in the selector communicates the
            // transition without making the map flash away.
            setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
        }
        try {
            const data = await fetchVoyageLog(handle, trip);
            if (requestId !== requestSequence.current) return;
            const receivedAt = Date.now();
            setState({ status: 'ready', data });
            setLastSuccessfulAt(receivedAt);
            setNowMs(receivedAt);
            setPollFailed(false);
        } catch (e) {
            if (requestId !== requestSequence.current) return;
            if (e instanceof VoyageLogError && e.status === 404 && trip !== 'latest') {
                // A specifically selected trip may be deleted while the page
                // is open. Return gracefully to the auto-following newest
                // trip instead of leaving a stranded public link in error.
                setPollFailed(false);
                setRequestedTrip('latest');
                return;
            }
            const message = e instanceof VoyageLogError ? e.message : 'Something went wrong loading this voyage log.';
            // Don't blow away good data on a failed background refresh.
            // For 429 specifically, keep good data even on a foreground
            // trip-switch: quota exhaustion is transient (shared-IP viewers
            // draining the anon bucket), and the map already on screen beats
            // a "quota exceeded" error card while the boat is at sea
            // (audit 2026-08-02).
            const isQuota = e instanceof VoyageLogError && e.status === 429;
            setPollFailed(true);
            setState((prev) =>
                prev.status === 'ready' && (!showSpinner || isQuota) ? prev : { status: 'error', message },
            );
        } finally {
            if (requestId === requestSequence.current) setIsTripLoading(false);
        }
    }, []);

    // Poll results can stop arriving while the last successful payload remains
    // mounted. Re-render independently so relative ages and freshness labels
    // continue advancing even when neither fetch nor telemetry changes.
    useEffect(() => {
        const id = setInterval(() => setNowMs(Date.now()), DASHBOARD_CLOCK_MS);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        void load(true, requestedTrip);
        const refreshMs = requestedTrip === 'latest' ? LATEST_REFRESH_MS : HISTORY_REFRESH_MS;
        const id = setInterval(() => void load(false, requestedTrip), refreshMs);
        return () => clearInterval(id);
    }, [load, requestedTrip]);

    // Switching a voyage invalidates focused diary content: otherwise a card
    // from a previous passage could remain open over the newly selected map.
    useEffect(() => {
        setSelectedEntry(null);
        setLightbox(null);
    }, [requestedTrip]);

    // In auto-follow mode the server can advance from a completed trip to a
    // newly started one without the selector value changing (it remains
    // "latest"). Treat that as a real selection change too, so a story card
    // from yesterday is never left floating over today's track.
    const responseTripId = state.status === 'ready' ? state.data.selected_trip : null;
    const previousResponseTripId = useRef<string | null>(null);
    useEffect(() => {
        if (previousResponseTripId.current && responseTripId && previousResponseTripId.current !== responseTripId) {
            setSelectedEntry(null);
            setLightbox(null);
        }
        previousResponseTripId.current = responseTripId;
    }, [responseTripId]);

    // Selecting an entry flies the map there and opens its detail in the box.
    const handleSelect = useCallback((entry: VoyageLogEntry) => {
        setSelectedEntry(entry);
    }, []);

    const handleClear = useCallback(() => setSelectedEntry(null), []);
    const handleLightboxClose = useCallback(() => setLightbox(null), []);

    const handleTripChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        setRequestedTrip(event.target.value);
    }, []);

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
        trips = [],
        selected_trip: selectedTripId,
    } = state.data;

    const selectedTrip = trips.find((trip) => trip.id === selectedTripId) ?? null;
    const latestTrip =
        trips.find((trip) => trip.kind === 'track' && trip.active) ??
        trips.find((trip) => trip.kind === 'track') ??
        null;
    const isAllDiaryView = selectedTrip?.kind === 'all-diary' || selectedTripId === 'all-diary';
    // Historical tracks are a record, not a statement about where the boat is
    // now. Keep the live dials, AIS and progress strip reserved for the active
    // trip, and hide all of them in the all-diary catch-all.
    const isActiveTrackView =
        !isAllDiaryView &&
        (selectedTrip ? selectedTrip.kind === 'track' && selectedTrip.active : requestedTrip === 'latest');
    const scopedTelemetry = isActiveTrackView ? telemetry : null;

    /**
     * AIS gets its own rule, and it is about POSITION, not about the voyage's
     * active flag.
     *
     * These targets describe traffic right now, so the honest question is
     * whether the boat is still meaningfully where this page says it is. A
     * skipper who stopped tracking an hour ago is; a passage from last month
     * is not, and painting today's shipping over it would be a lie. Tying
     * them to `active` instead meant the targets vanished the moment tracking
     * stopped, which is exactly when someone ashore looks to see where he got
     * to (Shane 2026-09-02: "none of your 557 ais targets are showing").
     */
    /* Not a hook, deliberately: this sits below the loading/error early
       returns, so a useMemo here changes the hook count between renders and
       React throws. It does not need to be one either — the track arrives
       chronologically, so the newest fix is simply the last element. */
    const newestTrackPoint = track && track.length > 0 ? track[track.length - 1] : null;
    const parsedNewest = newestTrackPoint ? Date.parse(newestTrackPoint.timestamp) : Number.NaN;
    const newestTrackAt = Number.isFinite(parsedNewest) ? parsedNewest : null;
    const showNearbyVessels =
        !isAllDiaryView &&
        // A deliberately-chosen historical trip is a record; only the latest
        // view is a statement about where the boat is.
        (selectedTrip ? selectedTrip.id === latestTrip?.id : requestedTrip === 'latest') &&
        newestTrackAt !== null &&
        nowMs - newestTrackAt < AIS_POSITION_FRESH_MS;
    const expectedRefreshMs = requestedTrip === 'latest' ? LATEST_REFRESH_MS : HISTORY_REFRESH_MS;
    const responseOverdue =
        lastSuccessfulAt === null ||
        nowMs - lastSuccessfulAt >= Math.max(expectedRefreshMs * 2, PUBLIC_POSITION_FRESH_MS);
    const connectionLost = pollFailed || responseOverdue;
    const selectedTripLabel = selectedTrip?.label ?? null;
    const diaryTitle = isAllDiaryView ? 'All diary entries' : (selectedTripLabel ?? 'Voyage Log');
    const diaryContext = isAllDiaryView
        ? 'Every public diary entry, including notes not assigned to a voyage.'
        : selectedTripLabel
          ? `${selectedTrip?.active ? 'Live' : 'Historic'} trip diary`
          : undefined;
    const diaryEmptyMessage = isAllDiaryView
        ? 'No public diary entries yet.'
        : selectedTripLabel
          ? 'No public diary entries were recorded for this trip.'
          : 'No log entries published yet.';
    // The server-resolved id only changes when the applied selection changes.
    // It deliberately does not include live point updates, so a two-minute
    // refresh never wrests the camera away from a viewer who is panning.
    const mapFocusKey = selectedTripId ?? requestedTrip;
    const latestOptionLabel = latestTrip ? `Latest trip · ${latestTrip.label}` : 'Latest trip · No trip started yet';

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
                diaryHidden ? 'h-dvh overflow-hidden' : 'min-h-dvh'
            } md:h-screen md:overflow-hidden bg-slate-900 text-slate-100 font-sans`}
        >
            <TopNav
                vessel={vessel}
                telemetry={scopedTelemetry}
                entryCount={entries.length}
                nowMs={nowMs}
                connectionLost={connectionLost}
                lastSuccessfulAt={lastSuccessfulAt}
                viewStatus={
                    isAllDiaryView
                        ? 'All diary entries'
                        : selectedTrip && !selectedTrip.active
                          ? 'Historic trip'
                          : undefined
                }
            />

            {/* A public log is a voyage shelf, not a single rolling feed. The
                special latest option remains an auto-following mode; choosing
                a concrete track id below freezes that voyage during polling. */}
            <section
                aria-label="Voyage selection"
                className="shrink-0 border-b border-slate-700/80 bg-slate-900/95 px-4 py-2.5 shadow-xs backdrop-blur-md sm:px-6"
            >
                <div className="mx-auto flex max-w-(--breakpoint-2xl) flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-sky-400/25 bg-sky-400/10 text-sm text-sky-300">
                            ⛵
                        </span>
                        <div className="min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                                Voyage explorer
                            </p>
                            <p className="truncate text-xs font-medium text-slate-300">
                                {isAllDiaryView
                                    ? 'A complete public diary, across every trip.'
                                    : selectedTrip?.active
                                      ? 'Live track and its linked passage route.'
                                      : selectedTripLabel
                                        ? 'A saved record of this completed passage.'
                                        : 'Choose a trip, or follow the newest one.'}
                            </p>
                        </div>
                    </div>

                    <label className="group flex min-w-0 items-center gap-2 sm:w-100" aria-busy={isTripLoading}>
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                            Viewing
                        </span>
                        <span className="relative min-w-0 flex-1">
                            <select
                                value={requestedTrip}
                                onChange={handleTripChange}
                                disabled={isTripLoading}
                                aria-label="Choose a voyage to view"
                                className="h-9 w-full appearance-none rounded-lg border border-slate-600/90 bg-slate-800 px-3 pr-9 text-left text-xs font-semibold text-slate-100 outline-hidden transition-colors hover:border-sky-400/60 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-wait disabled:opacity-80"
                            >
                                <option value="latest">{latestOptionLabel}</option>
                                {trips.some((trip) => trip.kind === 'track') && (
                                    <optgroup label="Started trips">
                                        {trips
                                            .filter((trip) => trip.kind === 'track')
                                            .map((trip) => (
                                                <option key={trip.id} value={trip.id}>
                                                    {tripOptionLabel(trip)}
                                                    {trip.id === latestTrip?.id ? ' · current latest' : ''}
                                                </option>
                                            ))}
                                    </optgroup>
                                )}
                                {trips.some((trip) => trip.kind === 'all-diary') && (
                                    <optgroup label="Diary">
                                        {trips
                                            .filter((trip) => trip.kind === 'all-diary')
                                            .map((trip) => (
                                                <option key={trip.id} value={trip.id}>
                                                    {trip.label}
                                                </option>
                                            ))}
                                    </optgroup>
                                )}
                            </select>
                            <svg
                                aria-hidden="true"
                                className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="m7 10 5 5 5-5" />
                            </svg>
                            {isTripLoading && (
                                <span className="pointer-events-none absolute right-8 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-sky-300 border-t-transparent animate-spin" />
                            )}
                        </span>
                    </label>
                </div>
            </section>

            {isActiveTrackView && <VoyageProgressBar track={track} destination={destination} />}

            <div
                className={`relative flex flex-col md:flex-row md:flex-1 md:overflow-hidden ${
                    diaryHidden ? 'flex-1 min-h-0' : ''
                }`}
            >
                <main
                    className={`${
                        diaryHidden ? 'flex-1 min-h-0' : 'shrink-0 h-[52dvh] min-h-[360px]'
                    } md:shrink md:h-auto md:min-h-0 md:flex-1 bg-slate-950 relative`}
                >
                    <MapContainer
                        telemetry={scopedTelemetry}
                        destination={destination}
                        track={track}
                        entries={entries}
                        passageLine={passage?.plan_line ?? null}
                        waypoints={waypoints ?? EMPTY_WAYPOINTS}
                        nearbyVessels={showNearbyVessels ? (nearbyVessels ?? NO_VESSELS) : NO_VESSELS}
                        onEntryClick={handleSelect}
                        selectedEntryId={selectedEntry?.id}
                        focusKey={mapFocusKey}
                        // Fold/unfold changes the map's box — kick an
                        // explicit canvas resize so it fills the void.
                        resizeSignal={diaryHidden ? 1 : 0}
                        connectionLost={connectionLost}
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
                        <div className="w-full md:w-96 lg:w-[420px] flex flex-col min-h-0 md:h-full">
                            <DiarySidebar
                                entries={entries}
                                telemetry={scopedTelemetry}
                                instruments={state.data.instruments ?? null}
                                showTelemetry={requestedTrip === 'latest' && state.data.instruments_shared === true}
                                showSharingNotice={requestedTrip === 'latest' && state.data.instruments_shared !== true}
                                title={diaryTitle}
                                context={diaryContext}
                                emptyMessage={diaryEmptyMessage}
                                selectedEntry={selectedEntry}
                                onSelectEntry={handleSelect}
                                onClearSelection={handleClear}
                                onPhotoClick={handlePhoto}
                                nowMs={nowMs}
                                connectionLost={connectionLost}
                                lastSuccessfulAt={lastSuccessfulAt}
                            />
                        </div>
                    )}
                </aside>
            </div>

            {lightbox && (
                <Suspense fallback={null}>
                    <PhotoLightbox
                        photos={lightbox.photos}
                        startIndex={lightbox.index}
                        caption={lightbox.caption}
                        metadata={lightbox.metadata}
                        onClose={handleLightboxClose}
                    />
                </Suspense>
            )}
        </div>
    );
}
