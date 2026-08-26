/**
 * CastOffPanel — Manual voyage activation flow.
 *
 * Three-step process:
 *  1. Select Draft Voyage from list
 *  2. Pre-Departure Summary (crew, stores, weather)
 *  3. Safety Confirm toggle + CAST OFF button
 *
 * State protection: blocks if another voyage is already ACTIVE.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    getDraftVoyages,
    getActiveVoyage,
    castOff,
    endVoyage,
    createVoyage,
    updateActiveVoyageDetails,
    updateVoyage,
    type Voyage,
} from '../../services/VoyageService';
import {
    collapseGeneratedTraceEndpointPair,
    formatStoredPlannedRouteName,
} from '../../services/shiplog/plannedRouteNaming';
import { destNameFromRouteName, loadSavedTraces, stripLegBadge } from '../../services/routeTracer';
import { vesselCrewAboard } from '../../services/units';
import { getActiveLeg, getLegsForVoyage, closeLeg, startLeg, getLegSummary } from '../../services/VoyageLegService';
import type { PassageLeg } from '../../types/navigation';
import { triggerHaptic } from '../../utils/system';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { ChatService } from '../../services/ChatService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { EmptyState } from '../ui/EmptyState';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { stashCastOffHandoff, startHandoffGps } from '../../services/castOffHandoff';
import { FloatPlanSheet } from './FloatPlanSheet';
import { composeArrivalMessage } from '../../services/floatPlan';
import { useSettingsStore } from '../../stores/settingsStore';

interface CastOffPanelProps {
    onCastOff?: (voyage: Voyage) => void;
    onClose: () => void;
    /** Close this panel and open the Ship's Log — the live passage's home.
     *  Without it the active step was a dead end: back and X both landed on
     *  Passage Planning (Shane 2026-08-26: "how do i get to the log page
     *  from here???"). */
    onOpenLog?: () => void;
    /** Pre-selected voyage ID from passage planning — skips draft list */
    initialVoyageId?: string;
}

type Step = 'select' | 'create' | 'preflight' | 'active' | 'arrive' | 'depart_leg';

export const CastOffPanel: React.FC<CastOffPanelProps> = ({ onCastOff, onClose, onOpenLog, initialVoyageId }) => {
    const [step, setStep] = useState<Step>('select');
    const [drafts, setDrafts] = useState<Voyage[]>([]);
    const [selected, setSelected] = useState<Voyage | null>(null);
    const [activeVoyage, setActiveVoyage] = useState<Voyage | null>(null);
    const [loading, setLoading] = useState(true);
    const [casting, setCasting] = useState(false);
    const [ending, setEnding] = useState(false);
    const [trackingRetrying, setTrackingRetrying] = useState(false);
    const [trackingWarning, setTrackingWarning] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [safetyConfirmed, setSafetyConfirmed] = useState(false);
    // Public-page choice, remembered between passages (default: show). The
    // publish itself fires from castOffHandoff the moment GPS confirms —
    // any earlier is 'not-tracking' and records nothing.
    const [publishPublic, setPublishPublic] = useState(() => {
        try {
            return localStorage.getItem('thalassa_castoff_publish_public') !== '0';
        } catch {
            return true;
        }
    });
    const togglePublishPublic = useCallback(() => {
        setPublishPublic((v) => {
            try {
                localStorage.setItem('thalassa_castoff_publish_public', v ? '0' : '1');
            } catch {
                /* preference only */
            }
            return !v;
        });
        triggerHaptic('light');
    }, []);

    // Quick-create state
    const [newName, setNewName] = useState('');
    const [newFrom, setNewFrom] = useState('');
    const [newTo, setNewTo] = useState('');
    const [newCrew, setNewCrew] = useState(2);
    const [creating, setCreating] = useState(false);

    // Passage legs state
    const [currentLeg, setCurrentLeg] = useState<PassageLeg | null>(null);
    const [completedLegs, setCompletedLegs] = useState<PassageLeg[]>([]);
    const [arrivalPort, setArrivalPort] = useState('');
    const [showFloatPlan, setShowFloatPlan] = useState(false);
    // The close-out half. A float plan that is never cancelled either starts a
    // real search while the crew are ashore, or teaches the shore contact to
    // ignore the next one — so ending a voyage offers the stand-down message
    // rather than leaving the skipper to remember it.
    const [standDownText, setStandDownText] = useState<string | null>(null);
    const vesselName = useSettingsStore((s) => s.settings.vessel?.name);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const mountedRef = useRef(true);
    const endingRef = useRef(false);
    const trackingRetryRef = useRef(false);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            // Service operations remain authoritative after this panel closes,
            // but this particular mount may never update or close a newer
            // panel instance when its old promise eventually settles.
            mountedRef.current = false;
        };
    }, []);

    // Load drafts + check active
    useEffect(() => {
        const operationScope = getAuthIdentityScope();
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            const [d, active] = await Promise.all([getDraftVoyages(), getActiveVoyage()]);
            if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
            setDrafts(d);
            if (active) {
                setActiveVoyage(active);
                setStep('active');
                // Load leg state
                const activeLeg = getActiveLeg(active.id);
                setCurrentLeg(activeLeg);
                const allLegs = getLegsForVoyage(active.id).filter((l) => l.status === 'completed');
                setCompletedLegs(allLegs);

                // The server can already hold an active passage when a prior
                // Cast Off succeeded but its native GPS start failed. Never
                // render that state as a normal green "Live" passage: hydrate
                // the local tracker, compare the exact voyage id, and offer a
                // recovery on this screen.
                try {
                    const { ShipLogService } = await import('../../services/ShipLogService');
                    await ShipLogService.initialize();
                    if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
                    const tracking = ShipLogService.getTrackingStatus();
                    if (!tracking.isTracking || tracking.currentVoyageId !== active.id) {
                        setTrackingWarning(
                            'Passage is active, but GPS voyage logging is not recording. Retry GPS Logging now, or End Voyage if you are standing down.',
                        );
                    }
                } catch {
                    if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
                    setTrackingWarning(
                        'Passage is active, but GPS voyage logging could not be verified. Retry GPS Logging before relying on the track.',
                    );
                }
            } else if (initialVoyageId) {
                // Auto-select the passage planning voyage — skip draft list
                const match = d.find((v) => v.id === initialVoyageId);
                if (match) {
                    setSelected(match);
                    setStep('preflight');
                    setSafetyConfirmed(false);
                }
            }
            setLoading(false);
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [initialVoyageId]);

    const handleSelect = useCallback((voyage: Voyage) => {
        setSelected(voyage);
        setStep('preflight');
        setSafetyConfirmed(false);
        triggerHaptic('light');

        // Fire-and-forget: create private voyage channel for planning
        ChatService.createVoyageChannel(voyage.id, voyage.voyage_name).catch(() => {
            /* non-critical — channel can be created later */
        });
    }, []);

    const handleCreateVoyage = useCallback(async () => {
        if (!newName.trim()) return;
        setCreating(true);
        setError('');
        try {
            const result = await createVoyage({
                voyage_name: newName.trim(),
                departure_port: newFrom.trim() || null,
                destination_port: newTo.trim() || null,
                crew_count: newCrew,
            });
            if (result.voyage) {
                setDrafts((prev) => [...prev, result.voyage!]);
                setStep('select');
                setNewName('');
                setNewFrom('');
                setNewTo('');
                setNewCrew(2);
                triggerHaptic('medium');
            } else {
                setError(result.error || 'Failed to create voyage');
            }
        } catch (e) {
            console.warn('Suppressed:', e);
            setError('Failed to create voyage');
        }
        setCreating(false);
    }, [newName, newFrom, newTo, newCrew]);

    const handleCastOff = useCallback(async () => {
        if (!selected || !safetyConfirmed) return;
        const operationScope = getAuthIdentityScope();
        const operationIsCurrent = () => mountedRef.current && isAuthIdentityScopeCurrent(operationScope);
        setCasting(true);
        setError('');
        setTrackingWarning(null);
        triggerHaptic('heavy');
        let activatedVoyage: Voyage | null = null;

        try {
            const result = await castOff(selected.id);
            if (!operationIsCurrent()) return;
            if (result.ok && result.voyage) {
                activatedVoyage = result.voyage;
                // Hand off to the Log page IMMEDIATELY (Shane 2026-08-26:
                // "press the cast off button and the next button after that,
                // it goes to the log page"). The old flow dwelt here while a
                // cold GPS fix warmed at the dock — or stranded the skipper
                // in this panel when it failed. GPS logging now starts at
                // service level through the handoff (it must survive this
                // panel unmounting on navigation), and the Log page renders
                // the honest starting/failed/confirmed state plus the
                // route-check heads-up.
                stashCastOffHandoff({
                    voyageId: activatedVoyage.id,
                    voyageName: activatedVoyage.voyage_name,
                    caution: result.caution ?? null,
                    publishRoute: publishPublic,
                    savedRouteId: activatedVoyage.saved_route_id ?? null,
                });
                void startHandoffGps();
                onCastOff?.(activatedVoyage);
            } else {
                setError(result.error || 'Cast off failed');
            }
        } catch (cause) {
            if (!operationIsCurrent()) return;
            const detail =
                cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'Cast Off failed unexpectedly.';
            setError(`Cast Off could not be completed. ${detail}`);
        } finally {
            if (operationIsCurrent()) setCasting(false);
        }
    }, [selected, safetyConfirmed, publishPublic, onCastOff]);

    const handleRetryTracking = useCallback(async () => {
        if (!activeVoyage || casting || endingRef.current || trackingRetryRef.current) return;
        const operationScope = getAuthIdentityScope();
        const operationIsCurrent = () => mountedRef.current && isAuthIdentityScopeCurrent(operationScope);
        const voyageId = activeVoyage.id;
        trackingRetryRef.current = true;
        setTrackingRetrying(true);
        setError('');
        try {
            const { ShipLogService } = await import('../../services/ShipLogService');
            if (!operationIsCurrent()) return;
            await ShipLogService.startTracking(true, voyageId, operationScope);
            if (!operationIsCurrent()) return;
            const tracking = ShipLogService.getTrackingStatus();
            if (!tracking.isTracking || tracking.currentVoyageId !== voyageId) {
                throw new Error('Background GPS is still not recording this passage.');
            }
            setTrackingWarning(null);
            onCastOff?.(activeVoyage);
        } catch (cause) {
            if (!operationIsCurrent()) return;
            // Surface the REAL reason. The old unconditional "Fix location
            // access" tail sent the skipper to iOS Settings when the actual
            // blocker was another voyage holding the tracker.
            const detail =
                cause instanceof Error && cause.message.trim()
                    ? ` ${cause.message.trim()}`
                    : ' Fix location access, then retry.';
            setTrackingWarning(`GPS voyage logging is still off.${detail}`);
        } finally {
            trackingRetryRef.current = false;
            if (operationIsCurrent()) setTrackingRetrying(false);
        }
    }, [activeVoyage, casting, onCastOff]);

    const handleEndVoyage = useCallback(async () => {
        if (!activeVoyage || endingRef.current || casting || trackingRetryRef.current) return;
        const operationScope = getAuthIdentityScope();
        const operationIsCurrent = () => mountedRef.current && isAuthIdentityScopeCurrent(operationScope);
        const endingVoyage = activeVoyage;
        endingRef.current = true;
        setEnding(true);
        setError('');
        triggerHaptic('medium');
        const destination = endingVoyage.destination_port ?? undefined;
        try {
            const ended = await endVoyage(endingVoyage.id, 'completed');
            if (!operationIsCurrent()) return;
            if (!ended) {
                setError(
                    'End Voyage was not confirmed. The passage remains active and no stand-down was created. Retry End Voyage before leaving this screen.',
                );
                return;
            }

            // Offered, never auto-sent: the skipper decides whether anyone is
            // waiting on this. Compose only after both GPS teardown and the
            // owner-scoped archive mutation are confirmed.
            setStandDownText(composeArrivalMessage({ vesselName, destination, arrivedMs: Date.now() }));
            setShowFloatPlan(false);
            setActiveVoyage(null);
            setTrackingWarning(null);
            setCurrentLeg(null);
            setCompletedLegs([]);
            setStep('select');
            const d = await getDraftVoyages();
            if (operationIsCurrent()) setDrafts(d);
        } catch (cause) {
            if (!operationIsCurrent()) return;
            const detail = cause instanceof Error && cause.message.trim() ? ` ${cause.message.trim()}` : '';
            setError(`End Voyage could not be completed.${detail} Retry End Voyage.`);
        } finally {
            endingRef.current = false;
            if (operationIsCurrent()) setEnding(false);
        }
    }, [activeVoyage, casting, vesselName]);

    // ── Passage Leg Handlers ──

    const handleArriveAtPort = useCallback(() => {
        if (!activeVoyage || !currentLeg) return;
        triggerHaptic('light');
        // The leg's own planned destination (from the trip's saved legs)
        // beats the voyage-level destination: on a multi-leg passage the
        // voyage says "Auckland" while leg 1 actually ends at Noumea.
        setArrivalPort(currentLeg.planned_destination || activeVoyage.destination_port || '');
        setStep('arrive');
    }, [activeVoyage, currentLeg]);

    const handleConfirmArrival = useCallback(() => {
        if (!activeVoyage || !arrivalPort.trim()) return;
        triggerHaptic('medium');
        const closed = closeLeg(activeVoyage.id, arrivalPort.trim());
        if (closed) {
            setCompletedLegs((prev) => [...prev, closed]);
            setCurrentLeg(null);
            setStep('depart_leg');
        }
    }, [activeVoyage, arrivalPort]);

    const handleDepartNextLeg = useCallback(async () => {
        if (!activeVoyage || !arrivalPort.trim()) return;
        triggerHaptic('heavy');
        // The departure port for the next leg = the arrival port of the
        // previous leg. Its planned destination comes from the trip's saved
        // legs, so the NEXT "Arrive at Port" opens pre-filled too.
        let plannedDestination: string | null = null;
        try {
            const { tripLegPlannedDestination } = await import('../../services/routeTracer');
            plannedDestination = tripLegPlannedDestination(activeVoyage.saved_route_id, completedLegs.length + 1);
        } catch {
            /* best effort */
        }
        const newLeg = startLeg(activeVoyage.id, arrivalPort.trim(), plannedDestination);
        setCurrentLeg(newLeg);
        setArrivalPort('');
        setStep('active');
    }, [activeVoyage, arrivalPort, completedLegs.length]);

    const handleSkipToActive = useCallback(() => {
        setArrivalPort('');
        setStep('active');
    }, []);

    // Standard header back navigation — every step has a chevron home.
    const handleBack = useCallback(() => {
        triggerHaptic('light');
        if (step === 'create') {
            setStep('select');
        } else if (step === 'preflight') {
            setStep('select');
            setSelected(null);
        } else if (step === 'arrive' || step === 'depart_leg') {
            setArrivalPort('');
            setStep('active');
        } else {
            // 'select' and 'active' are the roots of their flows.
            onClose();
        }
    }, [step, onClose]);

    // ── Editable voyage endpoints ──
    // From/To come from splitting the route label at creation time, and a
    // tracer route named without the "A - B" form leaves the WHOLE name in
    // departure_port and nothing in destination_port — which then reads as
    // hard-coded nonsense on this screen (Shane 2026-08-04: "the origin and
    // destination is incorrect"). The cells are now inputs (and always
    // rendered — a null destination used to hide its cell entirely, so it
    // could never be fixed), persisting on blur.
    const [editFrom, setEditFrom] = useState('');
    const [editTo, setEditTo] = useState('');
    useEffect(() => {
        // Legacy rows (pre-2026-08 writers) hold the generated "<title> —
        // start"/"<title> — end" pair in BOTH ports. Seed the inputs with the
        // collapsed truth so the skipper sees a route name, not the artefact
        // (Shane 2026-08-26: From and To both read "Newport - (2nd Leg…");
        // the blur persist then heals the stored row on first touch.
        const collapsed = collapseGeneratedTraceEndpointPair(
            activeVoyage?.departure_port,
            activeVoyage?.destination_port,
        );
        if (collapsed) {
            // Slice the badge-STRIPPED base: destNameFromRouteName strips
            // "(2nd Leg)" internally, so slicing the raw name would chop the
            // badge mid-word for "A - B (2nd Leg)" titles. When the name
            // carries no "A - B" form at all, the saved trace's punter-named
            // destination is the last honest source (Shane 2026-08-26: 'i
            // still have the wrong info for the From and To').
            const base = stripLegBadge(collapsed).replace(/[\s—–-]+$/, '');
            let dest = destNameFromRouteName(collapsed);
            if (!dest && activeVoyage?.saved_route_id) {
                try {
                    dest =
                        loadSavedTraces().find((trace) => trace.id === activeVoyage.saved_route_id)?.destName || null;
                } catch {
                    dest = null;
                }
            }
            setEditFrom(
                dest && base.endsWith(dest)
                    ? base.slice(0, base.length - dest.length).replace(/[\s—–-]+$/, '')
                    : base || collapsed,
            );
            setEditTo(dest ?? '');
        } else {
            setEditFrom(activeVoyage?.departure_port ?? '');
            setEditTo(activeVoyage?.destination_port ?? '');
        }
        // Reseed only when the voyage itself changes — not on every row update.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeVoyage?.id]);
    const settingsVessel = useSettingsStore((s) => s.settings.vessel);
    const displayedCrewCount =
        activeVoyage && Number.isFinite(activeVoyage.crew_count) && activeVoyage.crew_count >= 1
            ? Math.round(activeVoyage.crew_count)
            : vesselCrewAboard(settingsVessel);

    const persistCrew = useCallback(
        async (next: number) => {
            if (!activeVoyage) return;
            const clamped = Math.max(1, Math.min(99, Math.round(next)));
            if (clamped === activeVoyage.crew_count) return;
            const { voyage, error: crewError } = await updateActiveVoyageDetails(activeVoyage.id, {
                crew_count: clamped,
            });
            if (voyage) setActiveVoyage(voyage);
            else if (crewError) setError(`Crew count was not saved: ${crewError}`);
        },
        [activeVoyage],
    );

    const persistPorts = useCallback(async () => {
        if (!activeVoyage) return;
        const departure_port = editFrom.trim() || null;
        const destination_port = editTo.trim() || null;
        if (
            departure_port === (activeVoyage.departure_port ?? null) &&
            destination_port === (activeVoyage.destination_port ?? null)
        ) {
            return;
        }
        // updateVoyage is planning-gated; this card shows ACTIVE voyages, so
        // edits used to be silently discarded (Shane 2026-08-26). The narrow
        // writer accepts both, and a failure is said out loud.
        const { voyage, error: portError } = await updateActiveVoyageDetails(activeVoyage.id, {
            departure_port,
            destination_port,
        });
        if (voyage) setActiveVoyage(voyage);
        else if (portError) setError(`Voyage endpoints were not saved: ${portError}`);
    }, [activeVoyage, editFrom, editTo]);

    return (
        <OverlayPortal className="bg-black/80 flex items-stretch justify-center" role="presentation">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="cast-off-title"
                className="w-full max-w-lg bg-[#0a0e14] overflow-y-auto pb-24 pt-[max(0.75rem,env(safe-area-inset-top))]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — safe-area padded like every other screen, with the
                    standard back chevron (Shane 2026-08-04: heading sat under
                    the status bar and there was no way back). */}
                <div className="flex items-center justify-between p-5 pb-3">
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={handleBack}
                            className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/5 text-gray-400 hover:bg-white/10"
                            aria-label="Back"
                        >
                            <svg
                                className="w-5 h-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <div className="p-2 rounded-xl bg-amber-500/10">
                            <span className="text-xl">⛵</span>
                        </div>
                        <div>
                            <h2 id="cast-off-title" className="text-base font-black text-white">
                                {step === 'active'
                                    ? 'Active Voyage'
                                    : step === 'preflight'
                                      ? 'Ready to Sail?'
                                      : step === 'create'
                                        ? 'New Voyage'
                                        : step === 'arrive'
                                          ? 'Port Arrival'
                                          : step === 'depart_leg'
                                            ? 'Next Leg'
                                            : 'Select Voyage'}
                            </h2>
                            <p className="text-[11px] text-amber-400/60 uppercase tracking-widest">
                                {step === 'active'
                                    ? 'Watch Mode'
                                    : step === 'preflight'
                                      ? 'Pre-Departure Check'
                                      : step === 'create'
                                        ? 'Quick Create'
                                        : step === 'arrive'
                                          ? 'Passage Legs'
                                          : step === 'depart_leg'
                                            ? 'Passage Legs'
                                            : 'Draft Voyages'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        ref={closeButtonRef}
                        onClick={onClose}
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-white/5 text-gray-400 hover:bg-white/10"
                        aria-label="Close dialog"
                    >
                        ✕
                    </button>
                </div>

                {loading && (
                    <div className="p-10 text-center">
                        <div className="w-6 h-6 border-2 border-amber-400/30 rounded-full border-t-amber-400 animate-spin mx-auto" />
                        <p className="text-xs text-gray-500 mt-3">Loading voyages…</p>
                    </div>
                )}

                {/* The "Log this track?" prompt is gone — Cast Off
                    auto-starts the GPS trip log now. The wizard goes
                    select → preflight → active. */}

                {/* ── Step 1: Active Voyage Warning ── */}
                {step === 'active' && activeVoyage && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="p-4 rounded-2xl bg-emerald-500/[0.06] border border-emerald-500/15 space-y-3">
                            <div className="flex items-center gap-2">
                                <div
                                    className={`w-2 h-2 rounded-full ${
                                        trackingWarning ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'
                                    }`}
                                />
                                <span
                                    className={`text-xs font-bold uppercase tracking-widest ${
                                        trackingWarning ? 'text-amber-300' : 'text-emerald-400'
                                    }`}
                                >
                                    {trackingWarning ? 'Passage Active · GPS Log Off' : 'Live'}
                                </span>
                                {currentLeg && (
                                    <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold uppercase bg-sky-500/10 text-sky-400 border border-sky-500/15">
                                        Leg {currentLeg.leg_number}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-lg font-black text-white">
                                {formatStoredPlannedRouteName(activeVoyage.voyage_name) ?? activeVoyage.voyage_name}
                            </h3>
                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                {/* Voyage endpoints — editable in place, and always
                                    rendered so an empty destination can be filled
                                    rather than silently hidden. These feed the
                                    float plan's From/To, so getting them right
                                    matters beyond cosmetics. */}
                                <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                    <label htmlFor="voyage-from" className="text-gray-500">
                                        From{currentLeg ? ` · Leg ${currentLeg.leg_number}` : ''}
                                    </label>
                                    <input
                                        id="voyage-from"
                                        type="text"
                                        value={editFrom}
                                        onChange={(e) => setEditFrom(e.target.value)}
                                        onBlur={persistPorts}
                                        onFocus={scrollInputAboveKeyboard}
                                        placeholder="Departure port"
                                        className="mt-0.5 w-full bg-transparent text-white font-bold outline-none placeholder-gray-600 border-b border-transparent focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                    <label htmlFor="voyage-to" className="text-gray-500">
                                        To
                                    </label>
                                    <input
                                        id="voyage-to"
                                        type="text"
                                        value={editTo}
                                        onChange={(e) => setEditTo(e.target.value)}
                                        onBlur={persistPorts}
                                        onFocus={scrollInputAboveKeyboard}
                                        placeholder="Destination"
                                        className="mt-0.5 w-full bg-transparent text-white font-bold outline-none placeholder-gray-600 border-b border-transparent focus:border-sky-500/40 transition-colors"
                                    />
                                </div>
                                <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                    <span className="text-gray-500">Crew</span>
                                    {/* Editable like From/To: legacy rows carry a
                                        creation-time crew snapshot (often the old
                                        hardcoded 1) that the float plan then
                                        repeats. An invalid stored value reads as
                                        the vessel's standing complement. */}
                                    <div className="mt-0.5 flex items-center gap-3">
                                        <button
                                            type="button"
                                            aria-label="Decrease crew"
                                            onClick={() => void persistCrew(displayedCrewCount - 1)}
                                            className="w-6 h-6 rounded-md bg-white/[0.06] text-white font-bold leading-none"
                                        >
                                            −
                                        </button>
                                        <p className="text-white font-bold tabular-nums">{displayedCrewCount}</p>
                                        <button
                                            type="button"
                                            aria-label="Increase crew"
                                            onClick={() => void persistCrew(displayedCrewCount + 1)}
                                            className="w-6 h-6 rounded-md bg-white/[0.06] text-white font-bold leading-none"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>
                                {activeVoyage.departure_time && (
                                    <div className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                        <span className="text-gray-500">Departed</span>
                                        <p className="text-white font-bold">
                                            {new Date(activeVoyage.departure_time).toLocaleString([], {
                                                ...(new Date(activeVoyage.departure_time).getFullYear() !==
                                                new Date().getFullYear()
                                                    ? { year: 'numeric' }
                                                    : {}),
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Completed legs timeline */}
                        {completedLegs.length > 0 && (
                            <div className="space-y-1.5">
                                <div className="flex items-center gap-2 px-1">
                                    <div className="w-1 h-3 rounded-full bg-sky-500" />
                                    <span className="text-[11px] font-bold text-sky-400 uppercase tracking-widest">
                                        Passage Legs
                                    </span>
                                </div>
                                {completedLegs.map((leg) => {
                                    const summary = getLegSummary(leg);
                                    return (
                                        <div
                                            key={leg.id}
                                            className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.04] flex items-center gap-2.5"
                                        >
                                            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 text-[11px] font-black flex items-center justify-center shrink-0">
                                                {summary.legNumber}
                                            </span>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[11px] font-bold text-white truncate">
                                                    {summary.route}
                                                </p>
                                                <p className="text-[11px] text-gray-500">
                                                    {summary.durationHours ? `${summary.durationHours}h` : '—'}
                                                    {summary.distanceNm ? ` · ${summary.distanceNm.toFixed(0)} NM` : ''}
                                                </p>
                                            </div>
                                            <span className="text-emerald-400 text-[11px]">✓</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* The live passage lives on the Ship's Log — this
                            is the primary door out of the management panel. */}
                        {onOpenLog && (
                            <button
                                onClick={() => {
                                    triggerHaptic('light');
                                    onOpenLog();
                                }}
                                className="w-full py-3.5 bg-cyan-500/10 border border-cyan-400/25 rounded-xl text-sm font-bold text-cyan-300 uppercase tracking-widest hover:bg-cyan-500/20 transition-colors active:scale-[0.97]"
                            >
                                🧭 Open Ship&rsquo;s Log
                            </button>
                        )}

                        {/* Arrive at Port — Stopover */}
                        {currentLeg && (
                            <button
                                onClick={handleArriveAtPort}
                                className="w-full py-3.5 bg-sky-500/10 border border-sky-500/20 rounded-xl text-sm font-bold text-sky-400 uppercase tracking-widest hover:bg-sky-500/20 transition-colors active:scale-[0.97]"
                            >
                                ⚓ Arrive at Port
                            </button>
                        )}

                        {/* Float plan sits with the active voyage, not behind
                            Cast Off: plans change, and a skipper who leaves
                            late or reroutes needs to re-send rather than be
                            told the moment has passed. */}
                        {activeVoyage && !showFloatPlan && (
                            <button
                                onClick={() => {
                                    triggerHaptic('light');
                                    setShowFloatPlan(true);
                                }}
                                className="w-full py-3.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm font-bold text-amber-300 uppercase tracking-widest hover:bg-amber-500/20 transition-colors active:scale-[0.97]"
                            >
                                📋 Float Plan
                            </button>
                        )}
                        {activeVoyage && showFloatPlan && (
                            <FloatPlanSheet voyage={activeVoyage} onClose={() => setShowFloatPlan(false)} />
                        )}

                        {trackingWarning && (
                            <div
                                role="alert"
                                className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-400/25 space-y-3"
                            >
                                <p className="text-sm font-semibold text-amber-100">{trackingWarning}</p>
                                {/* A zombie row looks identical to a fresh passage
                                    except for this pill — say the age out loud so a
                                    month-old active row is recognisable at a glance
                                    (Shane 2026-08-26: a 26-July voyage presented as
                                    the live passage). */}
                                {activeVoyage?.departure_time &&
                                    Date.now() - Date.parse(activeVoyage.departure_time) > 48 * 3_600_000 && (
                                        <p className="text-xs text-amber-200/80">
                                            This passage departed{' '}
                                            {Math.round(
                                                (Date.now() - Date.parse(activeVoyage.departure_time)) / 86_400_000,
                                            )}{' '}
                                            days ago. If it is over, End Voyage &amp; Archive stands it down.
                                        </p>
                                    )}
                                <button
                                    onClick={handleRetryTracking}
                                    disabled={casting || ending || trackingRetrying}
                                    className="w-full py-3 bg-amber-400 text-slate-950 rounded-xl text-xs font-black uppercase tracking-widest active:scale-[0.97] disabled:opacity-50 disabled:cursor-wait"
                                >
                                    {casting || trackingRetrying ? '⏳ Starting GPS Logging…' : '↻ Retry GPS Logging'}
                                </button>
                            </div>
                        )}

                        {error && (
                            <p role="alert" className="text-sm text-red-400 text-center">
                                {error}
                            </p>
                        )}
                        <button
                            onClick={handleEndVoyage}
                            disabled={ending || casting || trackingRetrying}
                            className="w-full py-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm font-bold text-red-400 uppercase tracking-widest hover:bg-red-500/20 transition-colors active:scale-[0.97] disabled:opacity-40 disabled:cursor-wait"
                        >
                            {ending ? '⏳ Ending Voyage…' : '🏁 End Voyage & Archive'}
                        </button>
                    </div>
                )}

                {/* ── Arrive at Port (close current leg) ── */}
                {step === 'arrive' && activeVoyage && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="text-center py-2">
                            <div className="text-4xl mb-2">⚓</div>
                            <h3 className="text-lg font-black text-white mb-1">Arrive at Port</h3>
                            <p className="text-xs text-gray-400">
                                Close Leg {currentLeg?.leg_number || completedLegs.length + 1} and log your arrival
                            </p>
                        </div>

                        <div>
                            <label className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                Arrival Port *
                            </label>
                            <input
                                type="text"
                                value={arrivalPort}
                                onChange={(e) => setArrivalPort(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                placeholder="e.g. Nouméa, New Caledonia"
                                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-sky-500/40 outline-none transition-colors"
                                autoFocus
                            />
                        </div>

                        <div className="space-y-2">
                            <button
                                onClick={handleConfirmArrival}
                                disabled={!arrivalPort.trim()}
                                className="w-full py-3.5 bg-gradient-to-r from-sky-500 to-sky-500 rounded-xl text-sm font-black text-white uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-20 shadow-lg shadow-sky-500/20"
                            >
                                ⚓ Confirm Arrival
                            </button>
                            <button
                                onClick={handleSkipToActive}
                                className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                ← Back
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Depart on Next Leg (or end voyage) ── */}
                {step === 'depart_leg' && activeVoyage && (
                    <div className="p-5 pt-2 space-y-4">
                        <div className="text-center py-2">
                            <div className="text-4xl mb-2">🚢</div>
                            <h3 className="text-lg font-black text-white mb-1">Arrived at {arrivalPort || 'port'}</h3>
                            <p className="text-xs text-gray-400">
                                Leg {completedLegs.length} complete. Ready to depart on the next leg?
                            </p>
                        </div>

                        {/* Quick leg summary */}
                        {completedLegs.length > 0 && (
                            <div className="p-3 rounded-xl bg-emerald-500/[0.04] border border-emerald-500/10">
                                {completedLegs.map((leg) => {
                                    const s = getLegSummary(leg);
                                    return (
                                        <div key={leg.id} className="flex items-center gap-2 py-1 text-[11px]">
                                            <span className="text-emerald-400 font-black">L{s.legNumber}</span>
                                            <span className="text-gray-300 truncate flex-1">{s.route}</span>
                                            <span className="text-gray-500">
                                                {s.durationHours ? `${s.durationHours}h` : ''}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {error && (
                            <p role="alert" className="text-sm text-red-400 text-center">
                                {error}
                            </p>
                        )}
                        <div className="space-y-2">
                            <button
                                onClick={handleDepartNextLeg}
                                className="w-full py-4 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-base font-black text-black uppercase tracking-[0.15em] transition-all active:scale-[0.96] shadow-lg shadow-amber-500/20"
                            >
                                🚢 Depart — Start Leg {completedLegs.length + 1}
                            </button>
                            <button
                                onClick={handleEndVoyage}
                                disabled={ending || casting || trackingRetrying}
                                className="w-full py-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm font-bold text-red-400 uppercase tracking-widest hover:bg-red-500/20 transition-colors active:scale-[0.97] disabled:opacity-40 disabled:cursor-wait"
                            >
                                {ending ? '⏳ Ending Voyage…' : '🏁 End Voyage Here'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Stand-down prompt. Shown after a voyage ends, above
                    everything else, because an uncancelled float plan is the
                    failure mode that starts a real search for a crew who are
                    already ashore. */}
                {standDownText && (
                    <div
                        data-testid="stand-down-prompt"
                        className="mx-5 mb-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3"
                    >
                        <p className="text-[11px] font-black uppercase tracking-widest text-emerald-300">
                            Close out your float plan
                        </p>
                        <p className="mt-1 text-[11px] leading-snug text-gray-300">{standDownText}</p>
                        <div className="mt-2 flex gap-2">
                            <button
                                onClick={() => setStandDownText(null)}
                                className="flex-1 rounded-lg bg-white/10 py-2 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                            >
                                Not now
                            </button>
                            <button
                                onClick={async () => {
                                    triggerHaptic('medium');
                                    try {
                                        const { Share } = await import('@capacitor/share');
                                        await Share.share({
                                            text: standDownText,
                                            dialogTitle: 'Tell them you are in',
                                        });
                                        setStandDownText(null);
                                    } catch {
                                        // Cancelled share sheets reject too —
                                        // keep the prompt so it can be retried.
                                    }
                                }}
                                className="flex-[2] rounded-lg bg-emerald-500/20 py-2 text-[11px] font-black uppercase tracking-wide text-emerald-200 active:scale-95"
                            >
                                Send &ldquo;we&rsquo;re in&rdquo;
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step 1: Draft Selection ── */}
                {step === 'select' && !loading && (
                    <div className="p-5 pt-2 space-y-3">
                        {drafts.length === 0 ? (
                            <EmptyState
                                icon="🗺️"
                                title="No draft voyages yet"
                                subtitle="Create your first passage to get started"
                                actionLabel="+ New Voyage"
                                onAction={() => {
                                    setStep('create');
                                    triggerHaptic('light');
                                }}
                                compact
                            />
                        ) : (
                            <>
                                {drafts.map((v) => (
                                    <button
                                        key={v.id}
                                        onClick={() => handleSelect(v)}
                                        className="w-full p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] text-left hover:bg-white/[0.05] hover:border-amber-500/20 transition-all active:scale-[0.98] group"
                                    >
                                        <div className="flex items-start justify-between">
                                            <div>
                                                <h3 className="text-sm font-bold text-white group-hover:text-amber-300 transition-colors">
                                                    {v.voyage_name}
                                                </h3>
                                                <p className="text-[11px] text-gray-500 mt-0.5">
                                                    {v.departure_port || '?'} → {v.destination_port || '?'}
                                                </p>
                                            </div>
                                            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase bg-sky-500/10 text-sky-400 border border-sky-500/15">
                                                Draft
                                            </span>
                                        </div>
                                        <div className="flex gap-3 mt-2 text-[11px] text-gray-500">
                                            <span>👥 {v.crew_count} crew</span>
                                            {v.eta && <span>ETA: {new Date(v.eta).toLocaleDateString()}</span>}
                                        </div>
                                    </button>
                                ))}

                                {/* Add button when drafts exist */}
                                <button
                                    onClick={() => {
                                        setStep('create');
                                        triggerHaptic('light');
                                    }}
                                    className="w-full py-3 text-xs font-bold text-amber-400/60 uppercase tracking-widest hover:text-amber-300 transition-colors"
                                >
                                    + New Voyage
                                </button>
                            </>
                        )}
                    </div>
                )}

                {/* ── Step: Quick Create Voyage ── */}
                {step === 'create' && (
                    <div className="p-5 pt-2 space-y-4">
                        <div>
                            <label className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                Voyage Name *
                            </label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                placeholder="e.g. Tangalooma Day Trip"
                                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
                                autoFocus
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                    From
                                </label>
                                <input
                                    type="text"
                                    value={newFrom}
                                    onChange={(e) => setNewFrom(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="Departure port"
                                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                    To
                                </label>
                                <input
                                    type="text"
                                    value={newTo}
                                    onChange={(e) => setNewTo(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="Destination"
                                    className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder-gray-600 focus:border-amber-500/40 outline-none transition-colors"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 block">
                                Crew Count
                            </label>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setNewCrew((c) => Math.max(1, c - 1))}
                                    className="w-11 h-11 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] active:scale-90"
                                >
                                    −
                                </button>
                                <span className="text-xl font-black text-amber-400 w-8 text-center tabular-nums">
                                    {newCrew}
                                </span>
                                <button
                                    onClick={() => setNewCrew((c) => Math.min(20, c + 1))}
                                    className="w-11 h-11 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white hover:bg-white/[0.1] active:scale-90"
                                >
                                    +
                                </button>
                            </div>
                        </div>

                        {error && (
                            <p role="alert" className="text-sm text-red-400 text-center">
                                {error}
                            </p>
                        )}

                        <div className="space-y-2">
                            <button
                                onClick={handleCreateVoyage}
                                disabled={!newName.trim() || creating}
                                className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-sm font-black text-black uppercase tracking-[0.15em] transition-all active:scale-[0.97] disabled:opacity-30 shadow-lg shadow-amber-500/20"
                            >
                                {creating ? '⏳ Creating…' : '✨ Create Draft Voyage'}
                            </button>
                            <button
                                onClick={() => setStep('select')}
                                className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                ← Back
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step 2: Cast Off Confirmation ── */}
                {step === 'preflight' && selected && (
                    <div className="p-5 pt-2 space-y-4">
                        {/* Voyage summary */}
                        <div className="text-center pb-2">
                            <h3 className="text-lg font-black text-white">{selected.voyage_name}</h3>
                            <p className="text-[11px] text-gray-500">
                                {selected.departure_port || '?'} → {selected.destination_port || '?'}
                            </p>
                            {selected.departure_time && (
                                <p className="text-[11px] text-amber-400/60 mt-1">
                                    Departure:{' '}
                                    {new Date(selected.departure_time).toLocaleDateString([], {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                    })}
                                </p>
                            )}
                        </div>

                        {/* Safety Confirm */}
                        <div className="p-4 rounded-xl bg-amber-500/[0.04] border border-amber-500/15">
                            <button
                                type="button"
                                role="checkbox"
                                aria-checked={safetyConfirmed}
                                aria-label="Confirm Safety — vessel is ready to depart for this voyage"
                                className="flex min-h-[44px] w-full cursor-pointer items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                                onClick={() => {
                                    setSafetyConfirmed((v) => !v);
                                    triggerHaptic('medium');
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                                        safetyConfirmed
                                            ? 'bg-amber-500 border-amber-500'
                                            : 'border-gray-600 bg-transparent'
                                    }`}
                                >
                                    {safetyConfirmed && (
                                        <svg
                                            className="w-4 h-4 text-black"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M4.5 12.75l6 6 9-13.5"
                                            />
                                        </svg>
                                    )}
                                </span>
                                <div>
                                    <p className="text-xs font-bold text-amber-300">Confirm Safety</p>
                                    <p className="text-[11px] text-gray-500">
                                        Vessel is ready to depart for this voyage
                                    </p>
                                </div>
                            </button>
                        </div>

                        {error && (
                            <p role="alert" className="text-sm text-red-400 text-center">
                                {error}
                            </p>
                        )}

                        {/* Public page — an option, never a condition */}
                        <button
                            type="button"
                            role="checkbox"
                            aria-checked={publishPublic}
                            aria-label="Show this passage on the public page"
                            onClick={togglePublishPublic}
                            className="flex min-h-[44px] w-full cursor-pointer items-center gap-3 rounded-xl border border-cyan-500/15 bg-cyan-500/[0.04] p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                        >
                            <span
                                aria-hidden="true"
                                className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                                    publishPublic
                                        ? 'bg-cyan-500 border-cyan-500 text-black'
                                        : 'border-gray-600 bg-transparent'
                                }`}
                            >
                                {publishPublic && '✓'}
                            </span>
                            <span className="flex-1">
                                <span className="block text-xs font-bold text-cyan-300">Show on the Public Page</span>
                                <span className="block text-[11px] text-gray-500">
                                    Family and crew can watch this passage live. Off keeps the line private.
                                </span>
                            </span>
                        </button>

                        {/* Actions */}
                        <div className="space-y-2">
                            <button
                                onClick={handleCastOff}
                                disabled={!safetyConfirmed || casting}
                                className="w-full py-4 bg-gradient-to-r from-amber-500 to-orange-500 rounded-xl text-base font-black text-black uppercase tracking-[0.2em] transition-all active:scale-[0.96] disabled:opacity-20 disabled:cursor-not-allowed shadow-lg shadow-amber-500/20"
                            >
                                {casting ? '⏳ Casting Off…' : '⚓ CAST OFF'}
                            </button>
                            <button
                                onClick={() => {
                                    setStep('select');
                                    setSelected(null);
                                }}
                                className="w-full py-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                ← Back to Draft Selection
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </OverlayPortal>
    );
};
