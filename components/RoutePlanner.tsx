import React, { useState, useEffect, useRef } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('RoutePlanner');
import { createPortal } from 'react-dom';
import {
    MapPinIcon,
    MapIcon,
    XIcon,
    LockIcon,
    CompassIcon,
    CrosshairIcon,
    CalendarIcon,
    SailBoatIcon,
    PowerBoatIcon,
    AlertTriangleIcon,
    ClockIcon,
    CalendarGridIcon,
} from './Icons';
import { SlideToAction } from './ui/SlideToAction';
import { MapHub } from './map/MapHub';
import { DepartureWindowSheet } from './passage/DepartureWindowSheet';
import { ComfortQuickConfig } from './passage/ComfortQuickConfig';
import { LegPickerDropdown } from './passage/LegPickerDropdown';
import { SavedLocationsPicker } from './passage/SavedLocationsPicker';
import { useVoyageForm, LOADING_PHASES } from '../hooks/useVoyageForm';
import { useUI } from '../context/UIContext';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';
import { PageHeader } from './ui/PageHeader';
import { RouteEnhancementChip } from './passage/RouteEnhancementChip';

export const RoutePlanner: React.FC<{
    onTriggerUpgrade: () => void;
    onBack?: () => void;
    /** When true, render the planner as an embedded section inside
     *  another page (e.g. Passage Planning). Drops the PageHeader
     *  + the page-level flex layout so the form fits cleanly inside
     *  a parent's content stream. The full-screen map modal still
     *  works (it's portaled to body) — the only thing that changes
     *  is the chrome around the form. */
    embedded?: boolean;
}> = ({ onTriggerUpgrade, onBack, embedded = false }) => {
    const {
        origin,
        setOrigin,
        destination,
        setDestination,
        departureDate,
        setDepartureDate,
        handleDateChange,
        isMapOpen,
        setIsMapOpen,
        mapSelectionTarget,
        loading,
        loadingStep,
        error,
        minDate,

        handleCalculate,
        handlePlanWindow,
        acceptWindowScenario,
        clearVoyagePlan,
        handleOriginLocation,
        handleMapSelect,
        openMap,

        // Departure-window planner
        planningWindow,
        windowScenarios,
        showWindowSheet,
        setShowWindowSheet,
        windowProgress,

        voyagePlan,
        vessel,
        usingDefaultVessel,
        isPro,
        mapboxToken,
    } = useVoyageForm(onTriggerUpgrade);

    // Comfort accordion expanded state lives here (lifted up from the
    // ComfortQuickConfig) so we can imperatively collapse the panel
    // the moment the user taps into the origin/destination/date
    // inputs. Without this, an open Comfort panel pushes those inputs
    // below the keyboard line — the on-screen keyboard then covers
    // them and the user can't see what they're typing.
    const [comfortExpanded, setComfortExpanded] = React.useState(false);
    const handleInputFocus = React.useCallback((e: React.FocusEvent<HTMLInputElement>) => {
        setComfortExpanded(false);
        scrollInputAboveKeyboard(e);
    }, []);

    // departureTime state removed 2026-05-05 — see comment near the
    // date input above. Time-of-day is set in Passage Planning.

    const [_tempMapSelection, setTempMapSelection] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const { setPage } = useUI();

    // Drive/Walk modes removed 2026-05-17 — Thalassa is a marine
    // planner; road routing is Apple Maps' job, and the three-mode
    // toggle was diluting the marine focus while duplicating an OS-
    // native capability. handleRoadDirections + Mapbox-driving
    // pipeline gone with it. If we ever want road directions on a
    // marina pin, deep-link out to Apple Maps via the chart picker.

    // ── Reset on every mount ──
    // Each visit starts fresh — wipes any leftover voyagePlan from a
    // previous session AND bumps the session id so any in-flight
    // enhancement-pipeline `saveVoyagePlan` calls from before are
    // dropped (see useVoyageForm's saveIfActive). This is the fix for
    // "open RoutePlanner and see half the previous route in the map
    // pane" — that was the background pipeline writing back to
    // WeatherContext after the user had already navigated away.
    //
    // Mount-only (deps `[]`) is intentional: re-running on every render
    // would wipe what the user just typed.
    useEffect(() => {
        clearVoyagePlan();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Auto-Navigate to Main Map when route completes ──
    // Note: we no longer clearVoyagePlan() inside this effect after
    // navigation. Letting the WeatherContext voyagePlan stay populated
    // means the background enhancement pipeline can keep refining the
    // route the user is now viewing on MapHub. The mount-reset effect
    // above wipes it next time the user comes back to RoutePlanner.
    const prevVoyagePlanRef = useRef(voyagePlan);
    useEffect(() => {
        // Only fire when voyagePlan transitions from null → populated
        if (voyagePlan && !prevVoyagePlanRef.current) {
            const detail: Record<string, unknown> = {};
            // Prefer voyagePlan.origin (preserved verbatim from the
            // user's typed input — see useVoyageForm.handleCalculate)
            // over the form state `origin`, because voyagePlan is the
            // single source of truth that survives the async pipeline.
            // Form state can be cleared between calculate-finish and
            // event-dispatch if the user navigates fast.
            const departureName = (typeof voyagePlan.origin === 'string' && voyagePlan.origin) || origin || 'Departure';
            const arrivalName =
                (typeof voyagePlan.destination === 'string' && voyagePlan.destination) || destination || 'Arrival';
            if (voyagePlan.originCoordinates) {
                detail.departure = {
                    lat: voyagePlan.originCoordinates.lat,
                    lon: voyagePlan.originCoordinates.lon,
                    name: departureName,
                };
            }
            if (voyagePlan.destinationCoordinates) {
                detail.arrival = {
                    lat: voyagePlan.destinationCoordinates.lat,
                    lon: voyagePlan.destinationCoordinates.lon,
                    name: arrivalName,
                };
            }
            log.info('[AutoNav] Route calculated, switching to main map', { departureName, arrivalName });
            setPage('map');
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('thalassa:passage-mode', { detail }));
            }, 300);
        }
        prevVoyagePlanRef.current = voyagePlan;
    }, [voyagePlan, origin, destination, setPage]);
    return (
        <div
            className={
                embedded ? 'relative flex flex-col' : 'relative flex-1 bg-slate-950 overflow-hidden flex flex-col'
            }
        >
            {!embedded && <PageHeader title="Route Planner" onBack={onBack} />}
            {/* Stays visible across the auto-nav from RoutePlanner → MapHub */}
            {/* because the chip listens to window events (no React tree dep). */}
            <RouteEnhancementChip />

            {/* FULL SCREEN MAP MODAL - PORTALED TO ESCAPE TRANSFORMS */}
            {isMapOpen &&
                createPortal(
                    <div className="fixed inset-0 z-[2000] bg-slate-900 flex flex-col">
                        <div className="relative flex-1">
                            <MapHub
                                mapboxToken={mapboxToken}
                                pickerMode={!!mapSelectionTarget}
                                pickerLabel={
                                    mapSelectionTarget
                                        ? `Tap to select ${mapSelectionTarget === 'origin' ? 'Origin' : 'Destination'}`
                                        : undefined
                                }
                                initialZoom={8}
                                center={
                                    voyagePlan?.originCoordinates
                                        ? {
                                              lat: voyagePlan.originCoordinates.lat,
                                              lon: voyagePlan.originCoordinates.lon,
                                          }
                                        : undefined
                                }
                                onLocationSelect={(lat, lon, name) => {
                                    if (mapSelectionTarget) {
                                        const selectionName =
                                            name ||
                                            `WP ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
                                        handleMapSelect(lat, lon, selectionName);
                                    }
                                }}
                            />
                        </div>

                        <div className="absolute top-6 left-4 z-[2200]">
                            <button
                                onClick={() => {
                                    setIsMapOpen(false);
                                    setTempMapSelection(null);
                                }}
                                aria-label="Go back to previous page"
                                className="bg-slate-900/90 hover:bg-slate-800 text-white p-3 rounded-full shadow-2xl border border-white/20 transition-all hover:scale-110 active:scale-95"
                            >
                                <svg
                                    className="w-6 h-6"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.75 19.5L8.25 12l7.5-7.5"
                                    />
                                </svg>
                            </button>
                        </div>
                    </div>,
                    document.body,
                )}

            {/* ═══ FORM INPUTS — always visible at top ═══ */}
            <div className="shrink-0 px-4 pb-3">
                <div className="max-w-xl mx-auto w-full space-y-2.5">
                    {/* Comfort thresholds — collapsible accordion at the top
                        of the form. Sets settings.comfortParams (canonical
                        store) which the isochrone router reads at compute
                        time to drop candidates whose wind/wave/angle
                        conditions exceed the user's tolerance. Replaced the
                        old Passage Intelligence Comfort Profile card which
                        wrote to a separate localStorage key the router
                        never read.

                        Controlled by RoutePlanner so we can auto-collapse
                        on input focus (the on-screen keyboard otherwise
                        covers the input the user just tapped into). */}
                    <ComfortQuickConfig expanded={comfortExpanded} onExpandedChange={setComfortExpanded} />

                    {/* Multi-leg passage helper — always visible.
                        Picking a trip selects which voyage we're
                        adding a leg to (drafts + active voyage).
                        Picking a leg fills the From box (and To if
                        the leg has a known arrival). For Leg N+1
                        (no arrival yet) From auto-fills with the
                        previous leg's arrival, To clears, and the
                        user types the next hop's destination.
                        The picker NEVER auto-fires the routing
                        engine — the user reviews + slides the
                        Calculate gesture themselves. An earlier
                        eager-auto-calc kicked the user to the map
                        the moment they touched the trip dropdown,
                        which broke the multi-leg planning flow. */}
                    <LegPickerDropdown onSelectDeparture={setOrigin} onSelectDestination={setDestination} />

                    {/* Origin */}
                    <div className="relative group">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-emerald-400">
                            <MapPinIcon className="w-4 h-4" />
                        </div>
                        <input
                            type="text"
                            value={origin}
                            onChange={(e) => setOrigin(e.target.value)}
                            onFocus={handleInputFocus}
                            placeholder="Type departure port or tap map…"
                            aria-label="Departure port or location"
                            className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-32 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => openMap('origin')}
                                className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg"
                                title="Select on Map"
                                aria-label="Select origin on map"
                            >
                                <MapIcon className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => handleOriginLocation(e as React.MouseEvent<HTMLButtonElement>)}
                                className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg"
                                title="Use Current Location"
                                aria-label="Use Current Location"
                            >
                                <CrosshairIcon className="w-4 h-4" />
                            </button>
                            <SavedLocationsPicker value={origin} onPick={setOrigin} target="origin" />
                        </div>
                    </div>

                    {/* Destination */}
                    <div className="relative group">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-purple-400">
                            <MapPinIcon className="w-4 h-4" />
                        </div>
                        <input
                            type="text"
                            value={destination}
                            onChange={(e) => setDestination(e.target.value)}
                            onFocus={handleInputFocus}
                            placeholder="Type destination or tap map…"
                            aria-label="Destination port or location"
                            className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-24 text-sm text-white font-medium placeholder-gray-500 outline-none transition-all shadow-inner"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => openMap('destination')}
                                className="p-2 text-gray-400 hover:text-sky-400 transition-colors hover:bg-white/10 rounded-lg"
                                title="Select on Map"
                                aria-label="Select destination on map"
                            >
                                <MapIcon className="w-4 h-4" />
                            </button>
                            <SavedLocationsPicker value={destination} onPick={setDestination} target="destination" />
                        </div>
                    </div>

                    {/* Departure date — time-of-day is set later in
                        Passage Planning (the time card was removed
                        2026-05-05 because it was never threaded into
                        the saved plan and only confused the form). */}
                    <div className="relative w-full min-w-0 group">
                        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-400 group-focus-within:text-sky-400 transition-colors">
                            <CalendarIcon className="w-4 h-4" />
                        </div>
                        <input
                            type="date"
                            min={minDate}
                            value={departureDate}
                            onChange={(e) => {
                                const d = e.target.value;
                                if (!minDate || d >= minDate) {
                                    // handleDateChange updates form state
                                    // AND syncs the new date through to
                                    // the active voyage record (if any)
                                    // so the Passage Summary, Crew
                                    // Management dropdown, etc. all
                                    // reflect the change immediately
                                    // without requiring a re-Calculate.
                                    handleDateChange(d);
                                }
                            }}
                            onFocus={handleInputFocus}
                            aria-label="Departure date"
                            className="w-full h-12 bg-slate-900/50 border border-white/10 focus:border-sky-500/50 rounded-xl pl-12 pr-3 text-sm text-white font-medium outline-none transition-all shadow-inner hover:bg-slate-900/80 appearance-none min-w-0"
                            style={{ WebkitAppearance: 'none' }}
                        />
                    </div>
                </div>
            </div>

            {/* ═══ LOADING INDICATOR ═══ */}
            {loading && (
                <div className="shrink-0 flex justify-center py-2 animate-in fade-in z-10">
                    <div className="flex items-center gap-3 px-6 py-2.5 bg-slate-900/90 border border-sky-500/30 rounded-full shadow-[0_0_25px_rgba(14,165,233,0.15)]">
                        <span className="text-xs text-sky-300 font-mono tracking-wide">
                            {LOADING_PHASES[loadingStep]}
                        </span>
                        <div className="flex gap-1">
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-bounce"></div>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ ERROR ═══ */}
            {error && (
                <div className="shrink-0 px-4 pb-2">
                    <div className="max-w-xl mx-auto bg-red-500/10 border border-red-500/20 p-3 rounded-xl flex items-center gap-3 text-red-200 animate-in fade-in">
                        <AlertTriangleIcon className="w-4 h-4 shrink-0" />
                        <p className="text-xs flex-1">{error}</p>
                    </div>
                </div>
            )}

            {/* ═══ MAP — fills remaining space ═══ */}
            <div className="flex-1 min-h-0 relative">
                {voyagePlan ? (
                    <>
                        {/* Route summary overlay */}
                        <div className="absolute top-3 left-3 right-3 z-10 pointer-events-none">
                            <div className="pointer-events-auto inline-flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900/90 border border-white/10 backdrop-blur-sm shadow-2xl">
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                                    <span className="text-[11px] font-bold text-white truncate max-w-[120px]">
                                        {voyagePlan.origin}
                                    </span>
                                </div>
                                <svg
                                    className="w-4 h-4 text-gray-500 shrink-0"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                                    />
                                </svg>
                                <div className="flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-purple-400" />
                                    <span className="text-[11px] font-bold text-white truncate max-w-[120px]">
                                        {voyagePlan.destination}
                                    </span>
                                </div>
                                {voyagePlan.distanceApprox && (
                                    <span className="ml-1 px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 text-[11px] font-bold border border-sky-500/15">
                                        {voyagePlan.distanceApprox}
                                    </span>
                                )}
                                {voyagePlan.durationApprox && (
                                    <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-[11px] font-bold border border-amber-500/15">
                                        {voyagePlan.durationApprox}
                                    </span>
                                )}
                                {/* Plan Departure Window — opens the multi-departure
                                    optimiser sheet. Disabled while a route is being
                                    enhanced or while the planner itself is running. */}
                                <button
                                    onClick={() => handlePlanWindow()}
                                    disabled={planningWindow}
                                    className="px-2 py-0.5 rounded-full bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 text-[11px] font-bold border border-violet-500/20 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
                                    aria-label="Plan optimal departure window"
                                    title="Find best departure time"
                                >
                                    {planningWindow ? (
                                        <ClockIcon className="w-3 h-3" />
                                    ) : (
                                        <CalendarGridIcon className="w-3 h-3" />
                                    )}
                                    <span>Window</span>
                                </button>
                                {/* View on main map */}
                                <button
                                    onClick={() => {
                                        const detail: Record<string, unknown> = {};
                                        // Prefer voyagePlan.origin/destination (preserved
                                        // from the user's typed input via my override in
                                        // useVoyageForm.handleCalculate) over form state.
                                        const departureName =
                                            (typeof voyagePlan.origin === 'string' && voyagePlan.origin) ||
                                            origin ||
                                            'Departure';
                                        const arrivalName =
                                            (typeof voyagePlan.destination === 'string' && voyagePlan.destination) ||
                                            destination ||
                                            'Arrival';
                                        if (voyagePlan.originCoordinates) {
                                            detail.departure = {
                                                lat: voyagePlan.originCoordinates.lat,
                                                lon: voyagePlan.originCoordinates.lon,
                                                name: departureName,
                                            };
                                        }
                                        if (voyagePlan.destinationCoordinates) {
                                            detail.arrival = {
                                                lat: voyagePlan.destinationCoordinates.lat,
                                                lon: voyagePlan.destinationCoordinates.lon,
                                                name: arrivalName,
                                            };
                                        }
                                        log.info('[ViewOnMap] Passing coords:', JSON.stringify(detail));
                                        setPage('map');
                                        setTimeout(() => {
                                            window.dispatchEvent(new CustomEvent('thalassa:passage-mode', { detail }));
                                        }, 200);
                                    }}
                                    className="ml-auto p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 text-emerald-400 transition-all"
                                    aria-label="Open on main map"
                                    title="Open on main map"
                                >
                                    <CompassIcon className="w-4 h-4" rotation={0} />
                                </button>
                            </div>
                        </div>

                        {/* Inline route map */}
                        <MapHub
                            mapboxToken={mapboxToken}
                            pickerMode={false}
                            embedded
                            initialZoom={5}
                            center={
                                voyagePlan.originCoordinates
                                    ? {
                                          lat: voyagePlan.originCoordinates.lat,
                                          lon: voyagePlan.originCoordinates.lon,
                                      }
                                    : undefined
                            }
                        />
                    </>
                ) : (
                    /* Empty state — subtle map placeholder */
                    <div className="w-full h-full bg-slate-950" />
                )}
            </div>

            {/* ─── BOTTOM: CTA pinned above nav bar ─── */}
            {
                <div
                    className="fixed bottom-0 left-0 right-0 px-4 z-10 pointer-events-none"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <div className="max-w-xl mx-auto w-full pointer-events-auto">
                        {/* Active vessel indicator. `vessel` always
                            resolves now (configured or DEFAULT_VESSEL)
                            so the condition is effectively always
                            true — kept for resilience against future
                            null cases. When on DEFAULT, surface a
                            tiny "Personalise" hint that deep-links to
                            Settings → Vessel so the user can refine
                            for personalised polars/ETAs without
                            blocking the demo. */}
                        {vessel && (
                            <div className="flex items-center justify-center gap-2 mb-2 opacity-60">
                                {vessel.type === 'power' ? (
                                    <PowerBoatIcon className="w-3.5 h-3.5 text-slate-400" />
                                ) : (
                                    <SailBoatIcon className="w-3.5 h-3.5 text-slate-400" />
                                )}
                                <span className="text-[11px] font-mono text-slate-400 tracking-wide">
                                    Active Vessel: {vessel.name}
                                </span>
                                {usingDefaultVessel && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            // Deep-link to the Vessel Profile tab inside
                                            // Settings, same pattern as VesselHub's
                                            // "Set up your vessel" CTA. SettingsModal's
                                            // activeTab initialiser reads this key and
                                            // clears it on mount.
                                            try {
                                                localStorage.setItem('thalassa_settings_initial_tab', 'vessel');
                                            } catch {
                                                /* private-mode / quota — fall through */
                                            }
                                            setPage('settings');
                                        }}
                                        className="text-[11px] font-mono text-sky-400 hover:text-sky-300 underline underline-offset-2 transition-colors"
                                        aria-label="Personalise vessel profile in Settings"
                                    >
                                        Personalise →
                                    </button>
                                )}
                            </div>
                        )}
                        {!isPro ? (
                            <button
                                aria-label="Unlock route planning feature"
                                type="button"
                                onClick={onTriggerUpgrade}
                                className="h-14 w-full rounded-2xl font-bold uppercase tracking-wider text-xs transition-all shadow-lg flex items-center justify-center gap-2 bg-slate-800 text-white hover:bg-slate-700"
                            >
                                <LockIcon className="w-4 h-4 text-emerald-400" />
                                Unlock Route Planning
                            </button>
                        ) : (
                            <SlideToAction
                                label="Slide to Calculate Route"
                                thumbIcon={<CompassIcon className="w-5 h-5 text-white" rotation={0} />}
                                onConfirm={handleCalculate}
                                loading={loading}
                                loadingText={LOADING_PHASES[loadingStep] || 'Calculating…'}
                                theme="emerald"
                            />
                        )}
                    </div>
                </div>
            }

            {/* ─── Departure-Window Optimiser Sheet ─── */}
            {/* Modal sheet that surfaces planDepartureWindow() — runs ~14
                isochrone scenarios across the next 7 days and ranks them
                by ETA + gale exposure. Tapping a scenario sets the
                form's departureDate and closes the sheet, ready for the
                user to slide-to-calculate at the new time. */}
            <DepartureWindowSheet
                open={showWindowSheet}
                onClose={() => setShowWindowSheet(false)}
                planning={planningWindow}
                scenarios={windowScenarios}
                progressLabel={windowProgress}
                onAccept={acceptWindowScenario}
                origin={voyagePlan?.origin || origin}
                destination={voyagePlan?.destination || destination}
            />
        </div>
    );
};
