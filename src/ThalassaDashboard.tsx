import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import TopNav from './components/TopNav';
import MapContainer from './components/MapContainer';
import DiarySidebar, { type PublicVoyagePanel } from './components/DiarySidebar';
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
import { usePublicInstrumentFeed } from './usePublicInstrumentFeed';

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

// Match the lg layout breakpoint, including wide phones in landscape.
// CSS owns visibility; this keeps the fast instrument poll asleep off-screen.
function usePublicMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.(query);
        if (!media) return;
        const update = () => setMatches(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, [query]);
    return matches;
}

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
    const focusPanelAfterMapSelection = useRef(false);
    // Open photo lightbox, if any.
    const [lightbox, setLightbox] = useState<LightboxState | null>(null);
    // Desktop fold state survives polling. Phones use the bottom view switch
    // and can always open the panel, even after folding it on a larger screen.
    const [diaryHidden, setDiaryHidden] = useState(false);
    // Keep the viewer's choice across polling and folding the panel. Historic
    // trips always show their diary, never today's live instrument feed.
    const [panelView, setPanelView] = useState<PublicVoyagePanel | null>(null);
    // A phone opens on the map. Changing views never remounts MapContainer:
    // the viewer keeps their zoom, position and chosen basemap.
    const [mobileView, setMobileView] = useState<'map' | 'panel'>('map');
    const isMobile = usePublicMediaQuery('(max-width: 1023px)');
    const isShortLandscape = usePublicMediaQuery('(max-width: 1023px) and (max-height: 500px)');
    const [mapExpandedChoice, setMapExpandedChoice] = useState<boolean | null>(null);
    const mapExpanded = mobileView === 'map' && (mapExpandedChoice ?? isShortLandscape);
    const { handle } = parseVoyageLogParams();
    const instrumentPanelOpen =
        state.status === 'ready' &&
        requestedTrip === 'latest' &&
        (!diaryHidden || isMobile) &&
        panelView === 'instruments' &&
        (!isMobile || mobileView === 'panel');
    const instrumentFeed = usePublicInstrumentFeed(handle, instrumentPanelOpen);
    const { beginRequest: beginInstrumentRequest, acceptResponse: acceptInstruments } = instrumentFeed;

    const load = useCallback(
        async (showSpinner: boolean, trip: string) => {
            // Polls and picker changes can overlap on a slow satellite link. Only
            // the newest request is allowed to paint the page — otherwise an old
            // "latest" result can overwrite a deliberate historical selection.
            const requestId = ++requestSequence.current;
            const instrumentRequestId = beginInstrumentRequest();
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
                acceptInstruments(instrumentRequestId, data);
                // Pick a starting panel once. Late full responses cannot change
                // the viewer's choice or stop a newer consent-checked fast feed.
                setPanelView((previous) => previous ?? (data.instruments_shared === true ? 'instruments' : 'diary'));
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
                const message =
                    e instanceof VoyageLogError ? e.message : 'Something went wrong loading this voyage log.';
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
        },
        [acceptInstruments, beginInstrumentRequest],
    );

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
        focusPanelAfterMapSelection.current =
            document.getElementById('voyage-map')?.contains(document.activeElement) ?? false;
        setPanelView('diary');
        setDiaryHidden(false);
        setMobileView('panel');
        setSelectedEntry(entry);
    }, []);

    useEffect(() => {
        if (!focusPanelAfterMapSelection.current) return;
        focusPanelAfterMapSelection.current = false;
        // A keyboard marker activation hides its map on phones. Move focus
        // into the now-visible story instead of leaving it in a hidden tree.
        if (isMobile && mobileView === 'panel') {
            document.getElementById('voyage-panel-content')?.focus({ preventScroll: true });
        }
    }, [isMobile, mobileView, selectedEntry]);

    const handleClear = useCallback(() => setSelectedEntry(null), []);
    const handleLightboxClose = useCallback(() => setLightbox(null), []);

    const handleTripChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        setRequestedTrip(event.target.value);
    }, []);

    // A photo tap: focus the entry (so the box shows its story) + open fullscreen.
    const handlePhoto = useCallback((entry: VoyageLogEntry, index: number) => {
        setPanelView('diary');
        setDiaryHidden(false);
        setMobileView('panel');
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
        requestedTrip === 'latest' &&
        // While a picker request is in flight, the rendered data may still
        // belong to the historical trip we just left.
        (!selectedTrip || selectedTrip.id === latestTrip?.id) &&
        newestTrackAt !== null &&
        newestTrackAt <= nowMs + 60_000 &&
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
    // With no started trip, the server can resolve "latest" to all-diary;
    // shared instruments must still work for a boat sitting at her berth.
    const canViewInstruments = requestedTrip === 'latest';
    const visiblePanel = canViewInstruments ? (panelView ?? 'diary') : 'diary';
    const panelLabel = visiblePanel === 'instruments' ? 'instruments' : 'log entries';

    return (
        // One viewport, one phone view, with navigation outside the scrolling
        // panel. Desktop retains its map + sidebar. Safe areas include a
        // landscape notch and the home indicator; dvh follows browser chrome.
        <div
            className="flex h-dvh min-h-0 flex-col overflow-hidden bg-slate-900 text-slate-100 font-sans"
            style={{
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
                paddingLeft: 'env(safe-area-inset-left)',
                paddingRight: 'env(safe-area-inset-right)',
            }}
        >
            <div className={`shrink-0 ${mapExpanded ? 'hidden lg:block' : ''}`}>
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
                    className="shrink-0 border-b border-slate-700/80 bg-slate-900/95 px-3 py-1.5 shadow-xs backdrop-blur-md lg:px-6 lg:py-2.5"
                >
                    <div className="mx-auto flex max-w-(--breakpoint-2xl) flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="hidden min-w-0 items-center gap-2.5 lg:flex">
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

                        <label
                            className="group flex w-full min-w-0 items-center gap-2 lg:w-100"
                            aria-busy={isTripLoading}
                        >
                            <span className="hidden shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400 lg:block">
                                Viewing
                            </span>
                            <span className="relative min-w-0 flex-1">
                                <select
                                    value={requestedTrip}
                                    onChange={handleTripChange}
                                    disabled={isTripLoading}
                                    aria-label="Choose a voyage to view"
                                    className="h-11 min-h-[44px] w-full appearance-none rounded-lg border border-slate-600/90 bg-slate-800 px-3 pr-9 text-left text-base lg:text-sm font-semibold text-slate-100 outline-hidden transition-colors hover:border-sky-400/60 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-wait disabled:opacity-80"
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

                {isActiveTrackView && (
                    <div className={mobileView === 'panel' ? 'hidden lg:block' : ''}>
                        <VoyageProgressBar track={track} destination={destination} />
                    </div>
                )}
            </div>

            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
                <main
                    id="voyage-map"
                    aria-label="Voyage map"
                    className={`relative min-h-0 min-w-0 flex-1 bg-slate-950 ${mobileView === 'map' ? '' : 'hidden'} lg:block`}
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
                        selectedEntryId={visiblePanel === 'diary' ? selectedEntry?.id : undefined}
                        focusKey={mapFocusKey}
                        // Fold/unfold changes the map's box — kick an
                        // explicit canvas resize so it fills the void.
                        resizeSignal={
                            (diaryHidden ? 1 : 0) +
                            (mobileView === 'map' ? 2 : 0) +
                            (mapExpanded ? 4 : 0) +
                            (isMobile ? 8 : 0)
                        }
                        connectionLost={connectionLost}
                    />
                    <button
                        type="button"
                        onClick={() => setMapExpandedChoice(!mapExpanded)}
                        aria-label={mapExpanded ? 'Restore page header' : 'Expand map'}
                        aria-pressed={mapExpanded}
                        title={mapExpanded ? 'Restore page header' : 'Expand map'}
                        className="absolute left-16 top-3 flex h-11 w-11 items-center justify-center rounded-lg border border-white/20 bg-slate-950/90 text-teal-200 shadow-lg focus-visible:outline-2 focus-visible:outline-teal-200 lg:hidden"
                    >
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            className="h-5 w-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d={
                                    mapExpanded
                                        ? 'M9 3v6H3m18 6h-6v6M9 9 3 3m12 12 6 6'
                                        : 'M9 3H3v6m12 12h6v-6M3 3l6 6m6 6 6 6'
                                }
                            />
                        </svg>
                    </button>
                </main>

                {/* Desktop: fold rail + switch + one scrolling panel.
                    Phone: that same panel, with its switch in the bottom nav. */}
                <aside
                    className={`min-h-0 w-full flex-1 flex-col bg-slate-800 border-slate-700 lg:w-auto lg:flex-none lg:flex-row lg:border-l z-10 shadow-xl ${mobileView === 'panel' ? 'flex' : 'hidden'} lg:flex`}
                >
                    <button
                        type="button"
                        onClick={() => setDiaryHidden((v) => !v)}
                        aria-expanded={!diaryHidden}
                        aria-label={`${diaryHidden ? 'Show' : 'Hide'} ${panelLabel}`}
                        title={`${diaryHidden ? 'Show' : 'Hide'} ${panelLabel}`}
                        aria-controls="voyage-side-panel"
                        className="hidden shrink-0 items-center justify-center gap-2 lg:flex lg:w-7 bg-slate-800 hover:bg-slate-700/70 active:bg-slate-700 lg:border-r border-slate-700 text-slate-400 hover:text-sky-300 transition-colors"
                    >
                        <svg
                            className={`w-4 h-4 transition-transform duration-300 ${
                                diaryHidden ? 'lg:rotate-90' : 'rotate-180 lg:-rotate-90'
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                        <span className="text-[10px] font-bold uppercase tracking-widest lg:hidden">
                            {diaryHidden ? `Show ${panelLabel}` : `Hide ${panelLabel}`}
                        </span>
                    </button>
                    {(!diaryHidden || isMobile) && (
                        <div
                            id="voyage-side-panel"
                            className="w-full lg:w-[420px] flex flex-1 flex-col min-h-0 lg:h-full"
                        >
                            <div className="hidden shrink-0 border-b border-slate-700 bg-slate-900 p-3 lg:block">
                                <div
                                    role="group"
                                    aria-label="Side panel view"
                                    className="flex rounded-xl border border-slate-600/60 bg-slate-950 p-1"
                                >
                                    {(['instruments', 'diary'] as const).map((view) => (
                                        <button
                                            key={view}
                                            type="button"
                                            aria-pressed={visiblePanel === view}
                                            aria-controls="voyage-panel-content"
                                            disabled={view === 'instruments' && !canViewInstruments}
                                            title={
                                                view === 'instruments' && !canViewInstruments
                                                    ? 'Choose Latest trip to see current instruments'
                                                    : undefined
                                            }
                                            onClick={() => setPanelView(view)}
                                            className={`min-h-11 min-w-0 flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300 disabled:cursor-not-allowed disabled:opacity-40 ${
                                                visiblePanel === view
                                                    ? 'bg-teal-300 text-slate-950 shadow-sm'
                                                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                                            }`}
                                        >
                                            {view === 'instruments' ? 'Instruments' : 'Diary'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <DiarySidebar
                                entries={entries}
                                telemetry={scopedTelemetry}
                                instruments={instrumentFeed.snapshot?.instruments ?? null}
                                view={visiblePanel}
                                showTelemetry={
                                    canViewInstruments && instrumentFeed.snapshot?.instruments_shared === true
                                }
                                showSharingNotice={
                                    canViewInstruments && instrumentFeed.snapshot?.instruments_shared !== true
                                }
                                title={diaryTitle}
                                context={diaryContext}
                                emptyMessage={diaryEmptyMessage}
                                selectedEntry={selectedEntry}
                                onSelectEntry={handleSelect}
                                onClearSelection={handleClear}
                                onPhotoClick={handlePhoto}
                                nowMs={nowMs}
                                connectionLost={
                                    visiblePanel === 'instruments'
                                        ? instrumentFeed.failed ||
                                          instrumentFeed.lastSuccessfulAt === null ||
                                          nowMs - instrumentFeed.lastSuccessfulAt >= 30_000
                                        : connectionLost
                                }
                                lastSuccessfulAt={
                                    visiblePanel === 'instruments' ? instrumentFeed.lastSuccessfulAt : lastSuccessfulAt
                                }
                            />
                        </div>
                    )}
                </aside>
            </div>

            <nav
                aria-label="Voyage views"
                className="grid shrink-0 grid-cols-3 gap-1 border-t border-slate-600/60 bg-slate-950 px-2 py-1.5 lg:hidden"
            >
                {(['map', 'instruments', 'diary'] as const).map((view) => {
                    const active =
                        view === 'map' ? mobileView === 'map' : mobileView === 'panel' && visiblePanel === view;
                    return (
                        <button
                            key={view}
                            type="button"
                            aria-pressed={active}
                            aria-controls={view === 'map' ? 'voyage-map' : 'voyage-side-panel'}
                            disabled={view === 'instruments' && !canViewInstruments}
                            title={
                                view === 'instruments' && !canViewInstruments
                                    ? 'Choose Latest trip to see current instruments'
                                    : undefined
                            }
                            onClick={() => {
                                setMobileView(view === 'map' ? 'map' : 'panel');
                                if (view !== 'map') {
                                    setPanelView(view);
                                    setDiaryHidden(false);
                                }
                            }}
                            className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-teal-200 disabled:opacity-40 ${active ? 'bg-teal-300/15 text-teal-200' : 'text-slate-300 hover:bg-slate-800'}`}
                        >
                            <svg
                                aria-hidden="true"
                                className="h-5 w-5"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                {view === 'map' ? (
                                    <path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16" />
                                ) : view === 'instruments' ? (
                                    <>
                                        <circle cx="12" cy="12" r="9" />
                                        <path d="m12 12 4-5M5 12h1m12 0h1M12 5v1M9 17h6" />
                                    </>
                                ) : (
                                    <path d="M12 5C8 3 5 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-3-1-6-1-10 1Zm0 0v15" />
                                )}
                            </svg>
                            {view === 'map' ? 'Map' : view === 'instruments' ? 'Instruments' : 'Diary'}
                        </button>
                    );
                })}
            </nav>

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
