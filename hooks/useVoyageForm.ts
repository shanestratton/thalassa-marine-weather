import {
    useState,
    useEffect,
    useMemo,
    useCallback,
    useRef,
    useSyncExternalStore,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
// geminiService dynamically imported at call sites
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput } from '../utils';
import { parseCoordinateString } from '../utils/coordParse';
import { DeepAnalysisReport } from '../types';
import { LocationStore } from '../stores/LocationStore';
import { getErrorMessage } from '../utils/createLogger';
import { withTimeout } from '../utils/deadline';
import { generateSeaRoute } from '../utils/seaRoute';
import { GpsService } from '../services/GpsService';
import { resolveEffectiveVessel } from '../utils/defaultVessel';
import { vesselDraftMetres, vesselAirDraftMetres } from '../services/units';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import {
    createPassageEnhancementToken,
    dispatchPassageEnhancementEvent,
    PASSAGE_ENHANCEMENT_END_EVENT,
    PASSAGE_ENHANCEMENT_START_EVENT,
    type PassageEnhancementToken,
} from '../services/passageEnhancementEvents';

/**
 * Voyage-plan session counter — MODULE-scoped on purpose.
 *
 * The enhancement pipeline outlives the RoutePlanner that spawned it
 * (that's the point: it keeps refining the route while the user watches
 * MapHub). Its progressive saveVoyagePlan() writes are gated on this
 * counter still matching the value captured at Calculate-time.
 *
 * This used to be a useRef inside the hook, and that was the remount-
 * churn bug (2026-07-09): a ref dies with its hook instance, so when
 * the user hopped back to the PLAN tab, the NEW RoutePlanner's mount-
 * reset bumped a fresh ref the old pipeline never reads. The zombie
 * pipeline's next save then slipped past the guard, flipped voyagePlan
 * null→populated, and AutoNav yanked the user to the map — once per
 * remaining pipeline stage (~17 s and ~50 s after calculate), each yank
 * remounting MapHub and re-running its sticky-passage compute.
 *
 * Module scope means clearVoyagePlan() (every planner mount) stales
 * EVERY in-flight pipeline, whichever hook instance started it. Only
 * one planner exists at a time, so a shared counter is safe.
 */
let voyagePlanSession = 0;

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

function sameIdentityScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

/**
 * Keep local form state owned by the exact login generation that created it.
 *
 * `useEffect` cleanup is too late for this boundary: React can render once
 * after A→B with A's old hook state. Returning the new scope's initial value
 * synchronously prevents that flash, while the scope-bound setter makes
 * callbacks retained from A inert after the transition.
 */
function useIdentityScopedState<T>(
    scope: AuthIdentityScope,
    initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
    const initialFactoryRef = useRef<() => T>(
        typeof initialValue === 'function' ? (initialValue as () => T) : () => initialValue,
    );
    initialFactoryRef.current = typeof initialValue === 'function' ? (initialValue as () => T) : () => initialValue;

    const [ownedState, setOwnedState] = useState<{ scope: AuthIdentityScope; value: T }>(() => ({
        scope,
        value: initialFactoryRef.current(),
    }));
    const value = sameIdentityScope(ownedState.scope, scope) ? ownedState.value : initialFactoryRef.current();

    const setValue = useCallback<Dispatch<SetStateAction<T>>>(
        (nextValue) => {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setOwnedState((previous) => {
                if (!isAuthIdentityScopeCurrent(scope)) return previous;
                const previousValue = sameIdentityScope(previous.scope, scope)
                    ? previous.value
                    : initialFactoryRef.current();
                return {
                    scope,
                    value:
                        typeof nextValue === 'function'
                            ? (nextValue as (previousValue: T) => T)(previousValue)
                            : nextValue,
                };
            });
        },
        [scope],
    );

    return [value, setValue];
}

type VoyageFormOperationKind = 'calculate' | 'date' | 'window' | 'deep' | 'gps' | 'map';

interface ActiveEnhancementOperation {
    readonly scope: AuthIdentityScope;
    readonly session: number;
    readonly requestId: number;
    readonly controller: AbortController;
    readonly token: PassageEnhancementToken;
    timer: ReturnType<typeof setTimeout> | null;
}

let activeEnhancementOperation: ActiveEnhancementOperation | null = null;

function endActiveEnhancementOperation(): void {
    const active = activeEnhancementOperation;
    if (!active) return;
    activeEnhancementOperation = null;
    active.controller.abort();
    if (active.timer !== null) {
        clearTimeout(active.timer);
        active.timer = null;
    }
    dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_END_EVENT, active.token);
}

// The enhancement owner deliberately survives RoutePlanner → MapHub
// navigation, but an auth transition is a hard process-wide boundary even
// when the planner that started it has already unmounted.
subscribeAuthIdentityScope(() => {
    voyagePlanSession += 1;
    endActiveEnhancementOperation();
});

export const LOADING_PHASES = [
    'Reading the charts…',
    'Reading tidal streams…',
    'Checking notices to mariners…',
    'Plotting waypoints…',
    'Working out ETAs…',
    'Checking depth clearances…',
    'Checking air draft…',
    'Optimising the route…',
    'Weighing the weather…',
    'Checking safety margins…',
    'Reviewing pilotage notes…',
    'Drafting the passage plan…',
    'Finalising the route…',
    'Nearly there…',
];

export const useVoyageForm = (onTriggerUpgrade: () => void) => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);
    const { settings } = useSettings();
    const { weatherData, voyagePlan, saveVoyagePlan } = useWeather();
    const { vessel: configuredVessel, vesselUnits, units: generalUnits, isPro, mapboxToken } = settings;
    // Routing pipeline always sees a vessel — either the user's
    // configured one or DEFAULT_VESSEL (generic 35ft sloop). This
    // lets a fresh-install punter plan their first route without
    // first filling out a 12-field vessel form. Personal vessel
    // setup in Settings → Vessel takes precedence whenever it's
    // present, so this is a fallback, not a stomp.
    const vessel = resolveEffectiveVessel(configuredVessel);
    /** True when routing is running on DEFAULT_VESSEL. RoutePlanner
     *  surfaces a small "Default profile · Personalise →" hint
     *  next to the Active Vessel indicator so the user knows they
     *  CAN configure their own boat for personalised polars/ETAs. */
    const usingDefaultVessel = !configuredVessel;

    // Form State
    const [origin, setOrigin] = useIdentityScopedState(identityScope, '');
    const [destination, setDestination] = useIdentityScopedState(identityScope, '');
    const [via, setVia] = useIdentityScopedState(identityScope, '');
    const [departureDate, setDepartureDate] = useIdentityScopedState(
        identityScope,
        () => voyagePlan?.departureDate || new Date().toLocaleDateString('en-CA'),
    );

    // UI State
    const [isMapOpen, setIsMapOpen] = useIdentityScopedState(identityScope, false);
    const [mapSelectionTarget, setMapSelectionTarget] = useIdentityScopedState<'origin' | 'destination' | 'via' | null>(
        identityScope,
        null,
    );
    const [loading, setLoading] = useIdentityScopedState(identityScope, false);
    const [loadingStep, setLoadingStep] = useIdentityScopedState(identityScope, 0);
    const [error, setError] = useIdentityScopedState<string | null>(identityScope, null);

    // Deep Analysis State
    const [analyzingDeep, setAnalyzingDeep] = useIdentityScopedState(identityScope, false);
    const [deepReport, setDeepReport] = useIdentityScopedState<DeepAnalysisReport | null>(identityScope, null);

    // Departure-Window Planner State
    const [planningWindow, setPlanningWindow] = useIdentityScopedState(identityScope, false);
    const [windowScenarios, setWindowScenarios] = useIdentityScopedState<
        import('../services/departureWindow').DepartureScenario[]
    >(identityScope, () => []);
    const [showWindowSheet, setShowWindowSheet] = useIdentityScopedState(identityScope, false);
    const [windowProgress, setWindowProgress] = useIdentityScopedState<string | undefined>(identityScope, undefined);

    // Checklist State
    const [checklistState, setChecklistState] = useIdentityScopedState<Record<string, boolean>>(
        identityScope,
        () => ({}),
    );
    const [activeChecklistTab, setActiveChecklistTab] = useIdentityScopedState(identityScope, 'safety');

    // Session guard lives at module scope (voyagePlanSession above) —
    // a per-instance ref couldn't invalidate pipelines started by a
    // previous, now-unmounted planner instance.
    const mountedRef = useRef(false);
    const lifecycleGenerationRef = useRef(0);
    const operationRequestRef = useRef<Record<VoyageFormOperationKind, number>>({
        calculate: 0,
        date: 0,
        window: 0,
        deep: 0,
        gps: 0,
        map: 0,
    });
    const calculateAbortRef = useRef<AbortController | null>(null);
    const windowAbortRef = useRef<AbortController | null>(null);

    const invalidateUiOperations = useCallback(() => {
        lifecycleGenerationRef.current += 1;
        for (const kind of Object.keys(operationRequestRef.current) as VoyageFormOperationKind[]) {
            operationRequestRef.current[kind] += 1;
        }
        calculateAbortRef.current?.abort();
        calculateAbortRef.current = null;
        windowAbortRef.current?.abort();
        windowAbortRef.current = null;
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        const unsubscribe = subscribeAuthIdentityScope(() => {
            invalidateUiOperations();
        });
        return () => {
            mountedRef.current = false;
            invalidateUiOperations();
            unsubscribe();
        };
    }, [invalidateUiOperations]);

    // Reset Deep Report on param change
    useEffect(() => {
        if (voyagePlan?.origin !== origin || voyagePlan?.destination !== destination) {
            setDeepReport(null);
        }
    }, [voyagePlan, origin, destination, setDeepReport]);

    // Sync the date input from voyagePlan.departureDate when it loads.
    // The useState initializer above only fires once on mount — if
    // voyagePlan is still loading from WeatherContext at that point,
    // departureDate defaults to today and stays there even after
    // voyagePlan loads with the user's actual saved date. The user
    // then re-hits Calculate, today's date flows back into the new
    // voyage record, and the Passage Summary card displays today
    // instead of the date the user picked. This effect keeps the form
    // in sync with the loaded plan.
    useEffect(() => {
        if (voyagePlan?.departureDate && voyagePlan.departureDate !== departureDate) {
            setDepartureDate(voyagePlan.departureDate);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voyagePlan?.departureDate]);

    /**
     * Setting the departure date in the form should also push the new
     * date through to the active voyage record so the Passage Summary
     * card and the Crew Management dropdown both reflect it
     * immediately. Without this the user changes the date, navigates
     * to Crew Management, and still sees the old date because the
     * voyage record was only ever updated at Calculate-time.
     *
     * Match strategy: trimCountrySuffix on the active plan's origin /
     * destination, look up the matching draft voyage by name, update
     * its departure_time + recompute eta (preserving the original
     * duration delta). Mirrors WeatherWindowCard.acceptWindow.
     *
     * Non-blocking — if the voyage update fails (no Supabase auth, no
     * matching voyage, network error), we still update the form
     * state. The user can still re-Calculate to force a save.
     */
    const handleDateChange = useCallback(
        async (newDate: string) => {
            const operationScope = getAuthIdentityScope();
            if (!sameIdentityScope(operationScope, identityScope) || !isAuthIdentityScopeCurrent(operationScope)) {
                return;
            }
            const lifecycleGeneration = lifecycleGenerationRef.current;
            const requestId = ++operationRequestRef.current.date;
            const operationIsCurrent = () =>
                mountedRef.current &&
                lifecycleGeneration === lifecycleGenerationRef.current &&
                requestId === operationRequestRef.current.date &&
                sameIdentityScope(operationScope, identityScope) &&
                isAuthIdentityScopeCurrent(operationScope);
            if (!operationIsCurrent()) return;
            setDepartureDate(newDate);

            // Try to find the matching active voyage and update its
            // departure_time. We try three sources of origin/destination
            // names, in priority order:
            //   1. voyagePlan (post-Calculate, canonical)
            //   2. form state origin/destination (user typed but
            //      hasn't hit Calculate yet)
            //   3. nothing — bail out
            //
            // The previous version only used (1), which meant a user who
            // opened the form and changed the date WITHOUT first hitting
            // Calculate got their typed date saved into the form state
            // but the voyage record stayed on whatever date was saved
            // when the route was last calculated. The Passage Summary
            // then kept showing today (or whatever stale date the
            // voyage record had).
            const planOrigin = voyagePlan?.origin || origin;
            const planDestination = voyagePlan?.destination || destination;
            if (!planOrigin || !planDestination) return;

            try {
                // Build the expected voyage_name the same way
                // PassagePlanSave.createVoyage did:
                //   "{trimCountrySuffix(origin)} → {trimCountrySuffix(destination)}"
                // Inline the trim so we don't take a service dependency.
                const trim = (name: string) => {
                    const parts = name
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (parts.length === 0) return name;
                    if (parts.length === 1) return parts[0];
                    const last = parts[parts.length - 1];
                    if (/^[A-Z]{2,4}$/.test(last)) return parts.slice(0, -1).join(', ');
                    if (parts.length >= 3) return parts.slice(0, -1).join(', ');
                    return parts.join(', ');
                };
                const expectedName = `${trim(planOrigin)} → ${trim(planDestination)}`;

                const { getDraftVoyages, updateVoyage } = await import('../services/VoyageService');
                if (!operationIsCurrent()) return;
                const drafts = await getDraftVoyages();
                if (!operationIsCurrent()) return;
                let match = drafts.find((v) => v.voyage_name === expectedName);
                // Fallback: case-insensitive partial match on the place
                // names. Handles canonical-vs-typed differences (e.g.
                // saved "Newport → Nouméa" but form has "Newport, QLD").
                if (!match) {
                    const trimmedOrigin = trim(planOrigin).toLowerCase();
                    const trimmedDest = trim(planDestination).toLowerCase();
                    match = drafts.find((v) => {
                        const name = (v.voyage_name || '').toLowerCase();
                        return name.includes(trimmedOrigin) && name.includes(trimmedDest);
                    });
                }
                if (!match) {
                    console.warn(
                        `[useVoyageForm] handleDateChange: no draft voyage matching "${expectedName}" — date saved in form only`,
                    );
                    return;
                }

                // Compute new departure_time as midnight UTC of the
                // selected date. Preserve duration: if the existing
                // voyage has a valid (departure_time, eta) pair, the
                // new eta = new departure + (oldEta - oldDeparture).
                const newDepartureIso = new Date(`${newDate}T00:00:00Z`).toISOString();
                const patch: { departure_time: string; eta?: string } = {
                    departure_time: newDepartureIso,
                };
                if (match.departure_time && match.eta) {
                    const oldDep = new Date(match.departure_time).getTime();
                    const oldEta = new Date(match.eta).getTime();
                    if (!isNaN(oldDep) && !isNaN(oldEta) && oldEta > oldDep) {
                        const durationMs = oldEta - oldDep;
                        patch.eta = new Date(new Date(newDepartureIso).getTime() + durationMs).toISOString();
                    }
                }
                if (!operationIsCurrent()) return;
                await updateVoyage(match.id, patch);
                if (!operationIsCurrent()) return;

                // Update voyagePlan in WeatherContext so the form +
                // any other consumers see the new date without a
                // remount. Only do this if voyagePlan exists — if the
                // user hasn't Calculated yet, the WeatherContext has
                // no plan to update.
                if (voyagePlan && operationIsCurrent()) {
                    saveVoyagePlan({ ...voyagePlan, departureDate: newDate });
                }

                // Notify any open PassageSummaryCard / banner / etc.
                // to re-read the new departure time. Same event the
                // WeatherWindowCard fires on accept.
                try {
                    if (!operationIsCurrent()) return;
                    window.dispatchEvent(
                        new CustomEvent('thalassa:departure-time-updated', {
                            detail: {
                                voyageId: match.id,
                                hhmm: '00:00',
                                iso: newDepartureIso,
                                scopeKey: operationScope.key,
                                generation: operationScope.generation,
                            },
                        }),
                    );
                } catch {
                    /* SSR safety */
                }
            } catch (e) {
                if (!operationIsCurrent()) return;
                // Non-critical — user can still re-Calculate to force
                // a save. Form state already updated by setDepartureDate
                // above.
                console.warn('[useVoyageForm] handleDateChange voyage sync failed:', e);
            }
        },
        [voyagePlan, saveVoyagePlan, origin, destination, identityScope, setDepartureDate],
    );

    // Loading Animation Loop
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | undefined;
        if (loading) {
            setLoadingStep(0);
            interval = setInterval(() => {
                setLoadingStep((s) => {
                    if (s >= LOADING_PHASES.length - 1)
                        return LOADING_PHASES.length - 3 + ((s - (LOADING_PHASES.length - 3) + 1) % 3);
                    return s + 1;
                });
            }, 1800);
        }
        return () => clearInterval(interval);
    }, [loading, setLoadingStep]);

    // HANDLERS

    // Drive/Walk routing removed 2026-05-17 — Thalassa is a marine
    // planner; road routing is Apple Maps' job. The previous
    // `handleRoadDirections` (Mapbox Directions API → road polyline
    // + auto-placed turn waypoints) is gone. MapboxDirectionsService
    // itself stays — PinMapViewer + MapHub still use buildDirectionsVoyagePlan
    // for chart-pin and map-tap workflows. Only the planner's
    // three-mode toggle is gone.

    const handleCalculate = async (
        e?: React.FormEvent,
        overrides?: { origin?: string; destination?: string; via?: string },
    ) => {
        if (e) e.preventDefault();
        const operationScope = getAuthIdentityScope();
        const lifecycleGeneration = lifecycleGenerationRef.current;
        if (
            !mountedRef.current ||
            lifecycleGeneration !== lifecycleGenerationRef.current ||
            !sameIdentityScope(operationScope, identityScope) ||
            !isAuthIdentityScopeCurrent(operationScope)
        ) {
            return;
        }

        // ⚠️ BUILD-MARKER — unmissable sentinel. If you don't see this
        // line in Xcode console when you hit Calculate, the iOS app is
        // running an older JS bundle than the one on disk. Update the
        // datestamp every commit you push so it's easy to tell which
        // build is actually loaded.
        console.warn('[BUILD-MARKER] thalassa 2026-05-15T22:35 handleCalculate fired');

        // PAYWALL INTERCEPTION
        if (!isPro) {
            if (isAuthIdentityScopeCurrent(operationScope)) onTriggerUpgrade();
            return;
        }

        // Resolve effective inputs — overrides win over form state. The
        // override path is for callers like the LegPickerDropdown that
        // want to trigger calculate immediately after a state-setter
        // update; in that case the form state hasn't flushed yet and
        // reading `origin` / `destination` from the closure would see
        // the stale values, so the caller passes the new values
        // directly. Form state setters still run below for UI sync.
        const effOrigin = overrides?.origin ?? origin;
        const effDest = overrides?.destination ?? destination;
        const effVia = overrides?.via ?? via;

        if (!effOrigin || !effDest) return;

        const requestId = ++operationRequestRef.current.calculate;
        calculateAbortRef.current?.abort();
        endActiveEnhancementOperation();
        const controller = new AbortController();
        calculateAbortRef.current = controller;

        // No `!vessel` guard needed any more — resolveEffectiveVessel
        // above always returns a value (user's configured profile, or
        // DEFAULT_VESSEL as fallback). See utils/defaultVessel.

        // Auto-Format inputs before submission — except typed GPS
        // coordinates, which are a position, not prose. Title-casing
        // them mangles hemisphere letters ("27.4698'S" → "'s") and the
        // string must reach parseLocation verbatim.
        const fmtLoc = (s: string) => (parseCoordinateString(s) ? s.trim() : formatLocationInput(s));
        const fmtOrigin = fmtLoc(effOrigin);
        const fmtDest = fmtLoc(effDest);
        const fmtVia = effVia ? fmtLoc(effVia) : '';

        setOrigin(fmtOrigin);
        setDestination(fmtDest);
        setVia(fmtVia);

        // Bump session: this is a NEW route plan. Any pending enhancement
        // pipeline writes from a previous calculate are now stale and
        // will be dropped by saveIfActive below.
        voyagePlanSession += 1;
        const mySession = voyagePlanSession;
        const operationIsCurrent = () =>
            voyagePlanSession === mySession && !controller.signal.aborted && isAuthIdentityScopeCurrent(operationScope);
        const uiOperationIsCurrent = () =>
            mountedRef.current &&
            lifecycleGeneration === lifecycleGenerationRef.current &&
            requestId === operationRequestRef.current.calculate &&
            operationIsCurrent();
        const saveIfActive = (plan: import('../types').VoyagePlan) => {
            if (!operationIsCurrent()) return false;
            saveVoyagePlan(plan);
            return true;
        };

        if (!uiOperationIsCurrent()) return;
        setLoading(true);
        setError(null);
        setDeepReport(null);
        try {
            // ── DETERMINISTIC route compute (replaces Gemini) ──
            //
            // Gemini was hallucinating every safety-relevant field:
            //   - origin/destination: rewrote "Newport QLD" → "QLD",
            //     "Port Moselle NC" → "South Province" (the
            //     administrative region of Nouméa)
            //   - distanceApprox: claimed "1.9 days" for an 870 NM
            //     passage at 6 kn (actually ~7 days)
            //   - durationApprox: was a free-text LLM string, not math
            //   - waypoints: zigzag patterns that inflated summed leg
            //     distances 2× over the real sailable path
            //   - departureDate: sometimes echoed today instead of the
            //     user's pick
            //
            // We were already overriding all of those after the call —
            // paying real Gemini latency + tokens + hallucination risk
            // for fields we threw away. The deterministic compute below
            // does exactly what we kept, with no LLM in the loop.
            //
            // The enhancement pipeline that runs after this (bathymetric
            // router → weather router → depth analysis → multi-model
            // comparison) is what produces the safety-critical outputs:
            // depth-safe sea-following geometry, corridor-optimised ETA,
            // wind/wave conditions per waypoint. Those services use
            // GEBCO bathymetry + ECMWF/GFS forecasts + cost-optimal
            // graph search — not an LLM.
            //
            // The origin-only fetchFastWeather "weatherContext" peek that
            // used to feed Gemini's prompt is gone — the bathymetric and
            // weather routers fetch their own forecast coverage across
            // the full route via the route-weather edge function. No
            // consumer left for an origin-only context blob.
            //
            // userLocation is captured but currently unused by
            // computeVoyagePlan — disambiguation is handled by
            // parseLocation's Mapbox forward geocode, which already
            // accepts coordinate-suffixed inputs ("Port Moselle
            // (-22.2765, 166.4377)") for precise matching. Kept on the
            // signature for any future enrichment hook.
            const { computeVoyagePlan } = await import('../services/voyageCompute');
            if (!uiOperationIsCurrent()) return;
            const userLoc = LocationStore.getState();
            const userLocation =
                userLoc.lat !== 0 || userLoc.lon !== 0 ? { lat: userLoc.lat, lon: userLoc.lon } : undefined;
            // Loud trace just before computeVoyagePlan — confirms the
            // EXACT strings being passed in. If parseLocation's own
            // entry log doesn't fire after this, we know it's a stale-
            // bundle issue (Xcode didn't deploy the latest JS) rather
            // than a code-path issue. Both lines side-by-side make the
            // diagnosis trivial.
            console.warn(`[useVoyageForm] computeVoyagePlan input: origin="${fmtOrigin}" destination="${fmtDest}"`);
            // 45 s wall-clock watchdog: the geocoding chain inside
            // computeVoyagePlan (Supabase ports → Mapbox → Nominatim →
            // Gemini, sequential fallbacks) has no per-fetch bounds and
            // AbortSignal is a no-op under CapacitorHttp (see
            // utils/deadline.ts) — on stalled marine LTE the Calculate
            // spinner cycled LOADING_PHASES forever. Timing out into the
            // catch below gives the user a real error + working retry.
            const result = await withTimeout(
                computeVoyagePlan(
                    fmtOrigin,
                    fmtDest,
                    vessel,
                    departureDate,
                    vesselUnits,
                    generalUnits,
                    fmtVia,
                    undefined,
                    userLocation,
                ),
                null,
                45_000,
            );
            if (!uiOperationIsCurrent()) return;
            if (!result) {
                throw new Error('Route calculation timed out — check your connection and try again.');
            }

            // ── Show the plan IMMEDIATELY — don't wait for enhancements ──
            if (!saveIfActive(result)) return;
            setLoading(false);

            // ── Enhancement Pipeline (runs in background, progressively updates) ──
            // Each step saves the enhanced plan as it completes, so the UI updates incrementally.
            //
            // Emit window events around the pipeline so any visible-on-screen
            // surface (PassageBanner, MapHub overlay, etc.) can show the
            // "Refining route..." chip without prop-drilling. The basic
            // plan landed already; the user is likely navigated to MapHub
            // by now, but the route geometry is still being progressively
            // optimized for the next 10-30s.
            const enhancementToken = createPassageEnhancementToken(
                operationScope,
                `${operationScope.generation}:${mySession}:${requestId}`,
            );
            const activeEnhancement: ActiveEnhancementOperation = {
                scope: operationScope,
                session: mySession,
                requestId,
                controller,
                token: enhancementToken,
                timer: null,
            };
            activeEnhancementOperation = activeEnhancement;
            // Ownership has transferred to the module-level pipeline. Normal
            // RoutePlanner unmount must cancel UI work without aborting this.
            if (calculateAbortRef.current === controller) calculateAbortRef.current = null;
            dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_START_EVENT, enhancementToken);
            activeEnhancement.timer = setTimeout(async () => {
                activeEnhancement.timer = null;
                if (!operationIsCurrent() || activeEnhancementOperation !== activeEnhancement) return;
                let enhancedPlan = result;
                try {
                    // Step 0: Inshore routing via ENC — runs first so the rest
                    // of the pipeline doesn't waste time on an ocean-router-shaped
                    // problem when the user is doing a river/harbor passage.
                    //
                    // Triggers when (a) a Pi is reachable, (b) both endpoints
                    // fall inside an installed ENC cell's bbox, and (c) the
                    // straight-line distance is < 50 NM. The Pi rasterizes the
                    // ENC layers (LNDARE/DEPARE/OBSTRN/WRECKS/UWTROC) into a
                    // navigability grid and runs A* through the channel.
                    //
                    // If it succeeds, we stash the polyline as routeGeoJSON
                    // and skip the bathymetric/isochrone/corridor steps —
                    // they're designed for ocean passages and would either
                    // produce nothing or overwrite our channel-following route
                    // with a meaningless straight line through land.
                    let inshoreSucceeded = false;
                    try {
                        // Loud breadcrumb at the orchestrator level so a
                        // missing-coord skip is visible. Without this, the
                        // entire InshoreRouter pipeline can no-op silently
                        // (and you stare at an empty Xcode console wondering
                        // why none of the [InshoreRouter] logs appear).
                        const oc = result.originCoordinates;
                        const dc = result.destinationCoordinates;
                        console.warn(
                            `[useVoyageForm] inshore step: origin=${oc ? `${oc.lat.toFixed(4)},${oc.lon.toFixed(4)}` : 'MISSING'} dest=${dc ? `${dc.lat.toFixed(4)},${dc.lon.toFixed(4)}` : 'MISSING'}`,
                        );
                        if (!oc || !dc) {
                            console.warn(
                                `[useVoyageForm] inshore step skipped — origin/destination coords not yet resolved on the plan result. Pipeline continues with bathymetric/isochrone routers.`,
                            );
                        }
                        if (result.originCoordinates && result.destinationCoordinates) {
                            console.warn(`[useVoyageForm] inshore step: importing InshoreRouter…`);
                            const { tryInshoreRoute, inshoreRouteToGeoJSON } =
                                await import('../services/InshoreRouter');
                            if (!operationIsCurrent()) return;
                            // tryInshoreRoute works in metres but vessel.draft
                            // is stored in FEET — feeding feet straight in
                            // produces an absurd ~8 m safety cutoff on
                            // GMRT-derived charts and the router blocks the
                            // entire bay. vesselDraftMetres() is the single
                            // conversion authority (services/units.ts).
                            const draftMeters = vesselDraftMetres(vessel);
                            // 90 s wall-clock bound (field bug 2026-06-12):
                            // tryInshoreRoute awaits an untimed nav-markers
                            // fetch that can stall on marine LTE and wedge
                            // the enhancement pipeline forever. Timeout flows
                            // into the existing failure branch → amber
                            // "Inshore Routing Skipped" accordion.
                            const inshoreRes = await withTimeout(
                                tryInshoreRoute(
                                    result.originCoordinates,
                                    result.destinationCoordinates,
                                    draftMeters,
                                    vesselAirDraftMetres(vessel),
                                ),
                                {
                                    error: 'Inshore routing timed out — a chart-data download may have stalled on this connection.',
                                    code: 'timeout',
                                },
                                90_000,
                            );
                            if (!operationIsCurrent()) return;
                            if (inshoreRes && 'polyline' in inshoreRes) {
                                // LAND BACKSTOP (2026-06-12, Newport→Mooloolaba field
                                // bug): the engine treats uncharted space as open
                                // water, so a chart-coverage gap mid-corridor can
                                // yield a confident polyline straight across an
                                // island. Validate the final geometry against GEBCO
                                // before accepting; fails OPEN when GEBCO is
                                // unreachable (the backstop must not break offline
                                // routing the chart layer validated properly).
                                const { inshoreRouteCrossesLand } = await import('../services/routing/landBackstop');
                                if (!operationIsCurrent()) return;
                                const backstop = await inshoreRouteCrossesLand(inshoreRes.polyline);
                                if (!operationIsCurrent()) return;
                                if (backstop.crossesLand) {
                                    console.warn(
                                        `[useVoyageForm] inshore route REJECTED by land backstop (${backstop.runs.length} land run(s)) — falling back to offshore pipeline`,
                                    );
                                    enhancedPlan = {
                                        ...enhancedPlan,
                                        __inshoreRouting: {
                                            status: 'failed',
                                            error: 'Inshore charts do not cover the full passage — route fell back to offshore planning.',
                                            errorCode: 'land-backstop',
                                            cellsUsed: inshoreRes.cellsUsed,
                                        },
                                    };
                                    saveIfActive(enhancedPlan);
                                } else {
                                    enhancedPlan = {
                                        ...enhancedPlan,
                                        routeGeoJSON: inshoreRouteToGeoJSON(
                                            inshoreRes,
                                            result.originCoordinates,
                                            result.destinationCoordinates,
                                        ),
                                        __inshoreRouting: {
                                            status: 'success',
                                            cellsUsed: inshoreRes.cellsUsed,
                                            distanceNM: inshoreRes.distanceNM,
                                        },
                                    };
                                    inshoreSucceeded = true;
                                    saveIfActive(enhancedPlan);
                                }
                            } else if (inshoreRes && 'error' in inshoreRes) {
                                // Pi answered but couldn't route. Tag the plan
                                // so the UI can show a useful warning instead
                                // of failing silently while ocean routers also
                                // produce nothing on a too-short route.
                                console.warn(
                                    `[useVoyageForm] inshore router failed: ${inshoreRes.error} (${inshoreRes.code ?? 'no code'})`,
                                );
                                enhancedPlan = {
                                    ...enhancedPlan,
                                    __inshoreRouting: {
                                        status: 'failed',
                                        error: inshoreRes.error,
                                        errorCode: inshoreRes.code,
                                        cellsUsed: inshoreRes.cellsUsed,
                                    },
                                };
                                saveIfActive(enhancedPlan);
                            }
                        }
                    } catch (_) {
                        if (!operationIsCurrent()) return;
                        console.warn(`[useVoyageForm] inshore routing threw`, _);
                    }

                    // Step 1: Bathymetric routing — depth-safe waypoints.
                    // Skipped when inshore router already produced a polyline:
                    // GEBCO is too coarse to refine a 50m-resolution channel route
                    // and would overwrite our routeGeoJSON.
                    if (!inshoreSucceeded) {
                        try {
                            const { enhanceVoyagePlanWithBathymetry } = await import('../services/bathymetricRouter');
                            if (!operationIsCurrent()) return;
                            const bathymetricPlan = await enhanceVoyagePlanWithBathymetry(result, vessel);
                            if (!operationIsCurrent()) return;
                            enhancedPlan = bathymetricPlan;
                            saveIfActive(enhancedPlan);
                        } catch (_) {
                            if (!operationIsCurrent()) return;
                            console.warn(`[useVoyageForm]`, _);
                        }
                    }

                    // Step 1b: Detect direction-change bends in the curved
                    // bathymetric polyline and surface them as waypoints.
                    // The router only emits the high-level named WPs from
                    // Gemini; the actual sea-following geometry has bends at
                    // every shoal/headland avoidance that the user expects to
                    // see as named turn-points in the saved logbook route.
                    try {
                        if (enhancedPlan.routeGeoJSON?.geometry?.coordinates) {
                            const { detectBends } = await import('../services/passage/detectBends');
                            if (!operationIsCurrent()) return;
                            const existingWps: Array<{ lat: number; lon: number }> = [];
                            if (enhancedPlan.originCoordinates) existingWps.push(enhancedPlan.originCoordinates);
                            if (enhancedPlan.destinationCoordinates)
                                existingWps.push(enhancedPlan.destinationCoordinates);
                            for (const wp of enhancedPlan.waypoints || []) {
                                if (wp.coordinates) existingWps.push(wp.coordinates);
                            }
                            const coords = enhancedPlan.routeGeoJSON.geometry.coordinates as Array<[number, number]>;
                            const bends = detectBends(coords, { existingWaypoints: existingWps });
                            if (bends.length > 0) {
                                const bendWps = bends.map((b, i) => ({
                                    name: `Bend ${i + 1} (${Math.round(b.bendDeg)}°)`,
                                    coordinates: b.coordinates,
                                }));
                                // Merge in passage order — bend waypoints sort
                                // by their position along the route, then the
                                // Gemini-named WPs interleave naturally on
                                // distance-from-origin.
                                const merged = [...(enhancedPlan.waypoints || []), ...bendWps].sort((a, b) => {
                                    if (!enhancedPlan.originCoordinates || !a.coordinates || !b.coordinates) return 0;
                                    const oLat = enhancedPlan.originCoordinates.lat;
                                    const oLon = enhancedPlan.originCoordinates.lon;
                                    const da = (a.coordinates.lat - oLat) ** 2 + (a.coordinates.lon - oLon) ** 2;
                                    const db = (b.coordinates.lat - oLat) ** 2 + (b.coordinates.lon - oLon) ** 2;
                                    return da - db;
                                });
                                enhancedPlan = { ...enhancedPlan, waypoints: merged };
                                saveIfActive(enhancedPlan);
                            }
                        }
                    } catch (_) {
                        if (!operationIsCurrent()) return;
                        console.warn(`[useVoyageForm] bend detection failed`, _);
                    }

                    // Step 2a: Isochrone routing — wavefront propagation (PRIMARY).
                    // This is the same routing approach PredictWind, Expedition,
                    // qtVlm, Squid all use. Wavefronts propagate from departure
                    // every timeStep hours, weighted by polar performance at the
                    // local wind/wave conditions; the optimal path is whichever
                    // node reaches destination first.
                    //
                    // Returns null when:
                    //   - route is < 100 NM (coastal — bathymetric channel
                    //     geometry is more useful than isochrone)
                    //   - no wind grid available
                    //   - polar lookup empty
                    //   - engine fails or times out
                    // In those cases the corridor router below picks up the slack.
                    let isochroneSucceeded = false;
                    if (!inshoreSucceeded) {
                        try {
                            const { enhanceVoyagePlanWithIsochrone } = await import('../services/isochroneEnhancer');
                            if (!operationIsCurrent()) return;
                            const isoResult = await enhanceVoyagePlanWithIsochrone(enhancedPlan, vessel, departureDate);
                            if (!operationIsCurrent()) return;
                            if (isoResult) {
                                enhancedPlan = isoResult;
                                isochroneSucceeded = true;
                                saveIfActive(enhancedPlan);
                            }
                        } catch (_) {
                            if (!operationIsCurrent()) return;
                            console.warn(`[useVoyageForm] isochrone enhancement failed`, _);
                        }
                    }

                    // Step 2b: Weather routing — corridor optimisation (FALLBACK).
                    // Runs only when the isochrone engine couldn't produce a
                    // route. Builds a 30 NM-wide corridor along the centerline
                    // and runs A* through it. Less optimal than isochrone for
                    // bluewater but still benefits coastal short hops where the
                    // bathymetric routeGeoJSON is the real workhorse.
                    //
                    // Also skipped on inshore-routed plans: the corridor router
                    // builds a 30 NM-wide A* graph that for a river passage is
                    // mostly land and would happily overwrite our channel route
                    // with a straight line.
                    if (!isochroneSucceeded && !inshoreSucceeded) {
                        try {
                            const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                            if (!operationIsCurrent()) return;
                            const weatherEnhancedPlan = await enhanceVoyagePlanWithWeather(
                                enhancedPlan,
                                vessel,
                                departureDate,
                            );
                            if (!operationIsCurrent()) return;
                            enhancedPlan = weatherEnhancedPlan;
                            saveIfActive(enhancedPlan);
                        } catch (_) {
                            if (!operationIsCurrent()) return;
                            console.warn(`[useVoyageForm]`, _);
                        }
                    }

                    // Steps 3 & 4 can run in parallel (both read from enhancedPlan, write to separate fields)
                    const step3 = (async () => {
                        try {
                            const { enhanceRouteWithDepth } = await import('../services/WeatherRoutingService');
                            if (!operationIsCurrent()) return;
                            const { computeRoute: computeRt } = await import('../services/WeatherRoutingService');
                            if (!operationIsCurrent()) return;

                            const depthWaypoints = [];
                            if (enhancedPlan.originCoordinates) {
                                depthWaypoints.push({
                                    id: 'dep',
                                    lat: enhancedPlan.originCoordinates.lat,
                                    lon: enhancedPlan.originCoordinates.lon,
                                    name: enhancedPlan.origin || 'Departure',
                                });
                            }
                            for (const wp of enhancedPlan.waypoints || []) {
                                if (wp.coordinates) {
                                    depthWaypoints.push({
                                        id: wp.name || 'wp',
                                        lat: wp.coordinates.lat,
                                        lon: wp.coordinates.lon,
                                        name: wp.name || 'WP',
                                    });
                                }
                            }
                            if (enhancedPlan.destinationCoordinates) {
                                depthWaypoints.push({
                                    id: 'arr',
                                    lat: enhancedPlan.destinationCoordinates.lat,
                                    lon: enhancedPlan.destinationCoordinates.lon,
                                    name: enhancedPlan.destination || 'Arrival',
                                });
                            }

                            if (depthWaypoints.length >= 2) {
                                // computeRt/enhanceRouteWithDepth expect METRES;
                                // vessel.draft is FEET (see services/units.ts).
                                const draftM = vesselDraftMetres(vessel);
                                const routeAnalysis = computeRt(depthWaypoints, {
                                    speed: vessel.cruisingSpeed || 6,
                                    vesselDraft: draftM,
                                });
                                if (!operationIsCurrent()) return;
                                const depthEnhanced = await enhanceRouteWithDepth(routeAnalysis, draftM);
                                if (!operationIsCurrent()) return;
                                enhancedPlan.__depthSummary = {
                                    minDepth: depthEnhanced.minDepth,
                                    shallowSegments: depthEnhanced.shallowSegments,
                                    totalSegments: depthEnhanced.segments.length,
                                    segments: depthEnhanced.segments.map((s) => ({
                                        depth_m: s.depth_m ?? null,
                                        safety: s.depthSafety ?? 'unknown',
                                        costMultiplier: s.depthCostMultiplier ?? 1,
                                    })),
                                };
                            }
                        } catch (_) {
                            if (!operationIsCurrent()) return;
                            console.warn(`[useVoyageForm]`, _);
                        }
                    })();

                    const step4 = (async () => {
                        try {
                            const { queryMultiModel, recommendModels } =
                                await import('../services/weather/MultiModelWeatherService');
                            if (!operationIsCurrent()) return;

                            const comparisonPoints: { lat: number; lon: number; name?: string }[] = [];
                            if (enhancedPlan.originCoordinates) {
                                comparisonPoints.push({
                                    lat: enhancedPlan.originCoordinates.lat,
                                    lon: enhancedPlan.originCoordinates.lon,
                                    name: enhancedPlan.origin,
                                });
                            }
                            for (const wp of enhancedPlan.waypoints || []) {
                                if (wp.coordinates) {
                                    comparisonPoints.push({
                                        lat: wp.coordinates.lat,
                                        lon: wp.coordinates.lon,
                                        name: wp.name,
                                    });
                                }
                            }
                            if (enhancedPlan.destinationCoordinates) {
                                comparisonPoints.push({
                                    lat: enhancedPlan.destinationCoordinates.lat,
                                    lon: enhancedPlan.destinationCoordinates.lon,
                                    name: enhancedPlan.destination,
                                });
                            }

                            if (comparisonPoints.length >= 2) {
                                const midpoint = comparisonPoints[Math.floor(comparisonPoints.length / 2)];
                                const modelIds = recommendModels(midpoint.lat, midpoint.lon);
                                const multiModelResult = await queryMultiModel(comparisonPoints, modelIds);
                                if (!operationIsCurrent()) return;
                                if (multiModelResult) {
                                    enhancedPlan.__multiModelComparison = multiModelResult;
                                }
                            }
                        } catch (_) {
                            if (!operationIsCurrent()) return;
                            console.warn(`[useVoyageForm]`, _);
                        }
                    })();

                    // Wait for both parallel steps, then save final enhanced plan
                    await Promise.allSettled([step3, step4]);
                    if (!operationIsCurrent()) return;
                    saveIfActive({ ...enhancedPlan });
                } finally {
                    if (activeEnhancementOperation === activeEnhancement) activeEnhancementOperation = null;
                    dispatchPassageEnhancementEvent(PASSAGE_ENHANCEMENT_END_EVENT, enhancementToken);
                }
            }, 50);

            // ── Background: pre-compute isochrone so the map route is ready ──
            if (result.originCoordinates && result.destinationCoordinates) {
                import('../services/IsochronePrecomputeCache')
                    .then(({ precomputeIsochrone }) => {
                        if (!operationIsCurrent()) return;
                        return precomputeIsochrone(
                            result.originCoordinates!,
                            result.destinationCoordinates!,
                            departureDate || new Date().toISOString(),
                            operationScope,
                        );
                    })
                    .catch(() => {
                        /* Non-critical */
                    });
            }
        } catch (err: unknown) {
            if (!uiOperationIsCurrent()) return;
            setError(getErrorMessage(err) || "Couldn't plot that passage — check signal and try again.");
            // If the pipeline aborted before kicking off enhancements
            // we never emit the start event; if it failed mid-way the
            // setTimeout owner is responsible for emitting :end. This
            // catch covers the case where the basic Gemini call itself
            // threw — no enhancement chip should be lingering.
        } finally {
            if (uiOperationIsCurrent()) {
                setLoading(false);
                if (!activeEnhancementOperation && calculateAbortRef.current === controller) {
                    calculateAbortRef.current = null;
                }
            }
        }
    };

    /**
     * Open the departure-window sheet and run planDepartureWindow().
     *
     * Loads the same engine fields the main pipeline uses (wind grid,
     * polar, bathymetry, OSCAR currents, cyclone exclusions), then
     * iterates ~14 candidate departure times across the next 7 days
     * and ranks them by ETA + gale exposure.
     *
     * Streams partial results through an operation-owned callback so an
     * account transition cannot deliver an old route to a new planner.
     */
    const handlePlanWindow = useCallback(async () => {
        const operationScope = getAuthIdentityScope();
        if (!sameIdentityScope(operationScope, identityScope) || !isAuthIdentityScopeCurrent(operationScope)) {
            return;
        }
        const lifecycleGeneration = lifecycleGenerationRef.current;
        const requestId = ++operationRequestRef.current.window;
        windowAbortRef.current?.abort();
        const controller = new AbortController();
        windowAbortRef.current = controller;
        const operationIsCurrent = () =>
            mountedRef.current &&
            lifecycleGeneration === lifecycleGenerationRef.current &&
            requestId === operationRequestRef.current.window &&
            !controller.signal.aborted &&
            sameIdentityScope(operationScope, identityScope) &&
            isAuthIdentityScopeCurrent(operationScope);
        if (!operationIsCurrent()) return;

        if (!isPro) {
            onTriggerUpgrade();
            if (windowAbortRef.current === controller) windowAbortRef.current = null;
            return;
        }
        if (!origin || !destination) {
            setError('Origin and destination required.');
            if (windowAbortRef.current === controller) windowAbortRef.current = null;
            return;
        }
        // No `!vessel` guard — DEFAULT_VESSEL is used when the user
        // hasn't configured a personal vessel yet.

        // Same coord-verbatim rule as handleCalculate — a typed GPS
        // position must not be title-cased on its way to parseLocation.
        const fmtOrigin = parseCoordinateString(origin) ? origin.trim() : formatLocationInput(origin);
        const fmtDest = parseCoordinateString(destination) ? destination.trim() : formatLocationInput(destination);

        setShowWindowSheet(true);
        setPlanningWindow(true);
        setWindowScenarios([]);
        setError(null);

        try {
            // 1. Resolve coordinates
            const { parseLocation } = await import('../services/weather/api/geocoding');
            if (!operationIsCurrent()) return;
            const [originGeo, destGeo] = await Promise.all([parseLocation(fmtOrigin), parseLocation(fmtDest)]);
            if (!operationIsCurrent()) return;
            if (originGeo.lat === 0 || destGeo.lat === 0) {
                throw new Error('Could not geocode origin or destination.');
            }
            const o = { lat: originGeo.lat, lon: originGeo.lon };
            const d = { lat: destGeo.lat, lon: destGeo.lon };

            // 2. Load engine fields (mirrors isochroneEnhancer)
            const { WindStore } = await import('../stores/WindStore');
            if (!operationIsCurrent()) return;
            const { createWindFieldFromGrid } = await import('../services/weather/WindFieldAdapter');
            if (!operationIsCurrent()) return;
            const { SmartPolarStore } = await import('../services/SmartPolarStore');
            if (!operationIsCurrent()) return;
            const { DEFAULT_CRUISING_POLAR } = await import('../services/defaultPolar');
            if (!operationIsCurrent()) return;
            const { preloadBathymetry } = await import('../services/BathymetryCache');
            if (!operationIsCurrent()) return;

            // Wind: ensure grid is loaded for the route bbox
            if (!WindStore.getState().grid) {
                // Same fetch logic as isochroneEnhancer.ensureWindGridForRoute
                const minLat = Math.min(o.lat, d.lat);
                const maxLat = Math.max(o.lat, d.lat);
                const minLon = Math.min(o.lon, d.lon);
                const maxLon = Math.max(o.lon, d.lon);
                const latPad = Math.max((maxLat - minLat) * 0.3, 2);
                const lonPad = Math.max((maxLon - minLon) * 0.3, 2);
                const bbox = {
                    north: Math.min(maxLat + latPad, 85),
                    south: Math.max(minLat - latPad, -85),
                    west: minLon - lonPad,
                    east: maxLon + lonPad,
                };
                const supabaseUrl =
                    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
                    'https://pcisdplnodrphauixcau.supabase.co';
                const supabaseKey =
                    (typeof import.meta !== 'undefined' &&
                        (import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY)) ||
                    '';
                const { piCache } = await import('../services/PiCacheService');
                if (!operationIsCurrent()) return;
                const usePi = piCache.isAvailable();
                const url = usePi
                    ? `${piCache.baseUrl}/api/grib/wind-grid`
                    : `${supabaseUrl}/functions/v1/fetch-wind-grid`;
                const fetchController = new AbortController();
                const abortFetch = () => fetchController.abort();
                controller.signal.addEventListener('abort', abortFetch, { once: true });
                const fetchTimeout = setTimeout(() => fetchController.abort(), 20_000);
                let res: Response;
                try {
                    res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(usePi || !supabaseKey
                                ? {}
                                : { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }),
                        },
                        body: JSON.stringify(bbox),
                        signal: fetchController.signal,
                    });
                } finally {
                    clearTimeout(fetchTimeout);
                    controller.signal.removeEventListener('abort', abortFetch);
                }
                if (!operationIsCurrent()) return;
                if (res.ok) {
                    const buf = await res.arrayBuffer();
                    if (!operationIsCurrent()) return;
                    if (buf.byteLength > 200) {
                        const { decodeGrib2WindMultiHour } = await import('../services/weather/decodeGrib2Wind');
                        if (!operationIsCurrent()) return;
                        WindStore.setGrid(decodeGrib2WindMultiHour(buf));
                    }
                }
            }
            const windGrid = WindStore.getState().grid;
            if (!windGrid) {
                throw new Error('Wind data unavailable for this route.');
            }
            const windField = createWindFieldFromGrid(windGrid);
            const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;
            const bathyGrid = await preloadBathymetry(o, d);
            if (!operationIsCurrent()) return;

            // Currents (non-blocking on failure)
            let currentField = null;
            try {
                const { OceanCurrentService } = await import('../services/OceanCurrentService');
                if (!operationIsCurrent()) return;
                const { createCurrentFieldFromVectors } = await import('../services/weather/CurrentFieldAdapter');
                if (!operationIsCurrent()) return;
                const briefing = await OceanCurrentService.fetchCurrents(
                    {
                        north: Math.max(o.lat, d.lat) + 1,
                        south: Math.min(o.lat, d.lat) - 1,
                        east: Math.max(o.lon, d.lon) + 1,
                        west: Math.min(o.lon, d.lon) - 1,
                    },
                    0,
                    0,
                    vessel.cruisingSpeed || 6,
                    settings.currentNrtEnabled === true,
                );
                if (!operationIsCurrent()) return;
                currentField = createCurrentFieldFromVectors(briefing.vectors);
            } catch (_) {
                if (!operationIsCurrent()) return;
                /* non-critical */
            }

            // Cyclone exclusions (non-blocking on failure)
            let exclusionField = null;
            try {
                const { buildCycloneExclusionField } = await import('../services/cycloneAvoidance');
                if (!operationIsCurrent()) return;
                const cycloneField = await buildCycloneExclusionField(new Date().toISOString(), {
                    north: Math.max(o.lat, d.lat),
                    south: Math.min(o.lat, d.lat),
                    east: Math.max(o.lon, d.lon),
                    west: Math.min(o.lon, d.lon),
                });
                if (!operationIsCurrent()) return;
                exclusionField = cycloneField;
            } catch (_) {
                if (!operationIsCurrent()) return;
                /* non-critical */
            }
            if (!operationIsCurrent()) return;

            // Wave field (non-blocking on failure)
            let waveField = null;
            try {
                const { fetchWaveField } = await import('../services/weather/waveField');
                if (!operationIsCurrent()) return;
                const { createWaveFieldFromSamples } = await import('../services/weather/WaveFieldAdapter');
                if (!operationIsCurrent()) return;
                const data = await fetchWaveField(
                    {
                        north: Math.max(o.lat, d.lat) + 1,
                        south: Math.min(o.lat, d.lat) - 1,
                        east: Math.max(o.lon, d.lon) + 1,
                        west: Math.min(o.lon, d.lon) - 1,
                    },
                    new Date().toISOString(),
                );
                if (!operationIsCurrent()) return;
                waveField = createWaveFieldFromSamples(data);
            } catch (_) {
                if (!operationIsCurrent()) return;
                /* non-critical */
            }

            // Comfort params: blend vessel mechanical caps + user prefs +
            // preferredAngles. Mirrors the same logic isochroneEnhancer
            // uses so departure-window scenarios apply the same filter
            // as the full-resolution route compute.
            const userComfort = settings.comfortParams ?? {};
            const tightestWind =
                vessel.maxWindSpeed != null && userComfort.maxWindKts != null
                    ? Math.min(vessel.maxWindSpeed, userComfort.maxWindKts)
                    : (vessel.maxWindSpeed ?? userComfort.maxWindKts);
            const tightestWave =
                vessel.maxWaveHeight != null && userComfort.maxWaveM != null
                    ? Math.min(vessel.maxWaveHeight, userComfort.maxWaveM)
                    : (vessel.maxWaveHeight ?? userComfort.maxWaveM);
            const blendedComfort =
                tightestWind != null ||
                tightestWave != null ||
                userComfort.maxGustKts != null ||
                userComfort.preferredAngles
                    ? {
                          maxWindKts: tightestWind,
                          maxWaveM: tightestWave,
                          maxGustKts: userComfort.maxGustKts,
                          preferredAngles: userComfort.preferredAngles,
                      }
                    : undefined;

            // 3. Run the planner
            const { planDepartureWindow } = await import('../services/departureWindow');
            if (!operationIsCurrent()) return;
            // Window starts now (or at the user's picked date if it's later
            // than now). We anchor at midnight UTC of that day.
            const baseDateIso = departureDate
                ? new Date(`${departureDate}T00:00:00Z`).toISOString()
                : new Date().toISOString();
            const final = await planDepartureWindow(
                o,
                d,
                vessel,
                windField,
                polar,
                bathyGrid,
                currentField,
                exclusionField,
                waveField,
                blendedComfort,
                baseDateIso,
                {
                    shouldContinue: operationIsCurrent,
                    onProgress: ({ completed, total, scenarios }) => {
                        if (!operationIsCurrent()) return;
                        setWindowProgress(`Computing ${completed} of ${total}…`);
                        setWindowScenarios([...scenarios]);
                    },
                },
            );
            if (!operationIsCurrent()) return;
            setWindowScenarios(final);
        } catch (err) {
            if (!operationIsCurrent()) return;
            setError(getErrorMessage(err) || "Couldn't run the departure sweep — try again shortly.");
        } finally {
            if (operationIsCurrent()) {
                setPlanningWindow(false);
                setWindowProgress(undefined);
            }
            if (windowAbortRef.current === controller) windowAbortRef.current = null;
        }
    }, [
        isPro,
        origin,
        destination,
        vessel,
        departureDate,
        onTriggerUpgrade,
        settings.comfortParams,
        settings.currentNrtEnabled,
        identityScope,
        setError,
        setPlanningWindow,
        setShowWindowSheet,
        setWindowProgress,
        setWindowScenarios,
    ]);

    /**
     * Apply a chosen scenario from the departure-window sheet:
     * update the form's departureDate to the scenario's date, close
     * the sheet, and let the user re-run Calculate at the new time.
     */
    const acceptWindowScenario = useCallback(
        (scenario: import('../services/departureWindow').DepartureScenario) => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            // Set departureDate to the YYYY-MM-DD of the scenario's UTC departure
            const dateOnly = scenario.departureTime.split('T')[0];
            setDepartureDate(dateOnly);
            setShowWindowSheet(false);
        },
        [identityScope, setDepartureDate, setShowWindowSheet],
    );

    const handleDeepAnalysis = async () => {
        const operationScope = getAuthIdentityScope();
        if (!sameIdentityScope(operationScope, identityScope) || !isAuthIdentityScopeCurrent(operationScope)) {
            return;
        }
        const lifecycleGeneration = lifecycleGenerationRef.current;
        const requestId = ++operationRequestRef.current.deep;
        const operationIsCurrent = () =>
            mountedRef.current &&
            lifecycleGeneration === lifecycleGenerationRef.current &&
            requestId === operationRequestRef.current.deep &&
            sameIdentityScope(operationScope, identityScope) &&
            isAuthIdentityScopeCurrent(operationScope);
        if (!operationIsCurrent()) return;
        // `vessel` always resolves (configured or DEFAULT) so just
        // need a voyagePlan to analyse.
        if (!voyagePlan) return;
        setAnalyzingDeep(true);
        try {
            const { fetchDeepVoyageAnalysis } = await import('../services/geminiService');
            if (!operationIsCurrent()) return;
            const report = await fetchDeepVoyageAnalysis(voyagePlan, vessel);
            if (!operationIsCurrent()) return;
            setDeepReport(report);
        } catch (err: unknown) {
            if (!operationIsCurrent()) return;
            setError('Deep analysis unavailable. Please retry.');
        } finally {
            if (operationIsCurrent()) setAnalyzingDeep(false);
        }
    };

    const handleOriginLocation = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const operationScope = getAuthIdentityScope();
        if (!sameIdentityScope(operationScope, identityScope) || !isAuthIdentityScopeCurrent(operationScope)) {
            return;
        }
        const lifecycleGeneration = lifecycleGenerationRef.current;
        const requestId = ++operationRequestRef.current.gps;
        const operationIsCurrent = () =>
            mountedRef.current &&
            lifecycleGeneration === lifecycleGenerationRef.current &&
            requestId === operationRequestRef.current.gps &&
            sameIdentityScope(operationScope, identityScope) &&
            isAuthIdentityScopeCurrent(operationScope);
        if (!operationIsCurrent()) return;
        try {
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 30_000 });
            if (!operationIsCurrent() || !pos) return;
            const { latitude, longitude } = pos;
            let name = '';
            try {
                name = (await reverseGeocode(latitude, longitude)) ?? '';
            } catch {
                if (!operationIsCurrent()) return;
            }
            if (!operationIsCurrent()) return;
            const coordSuffix = `(${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
            setOrigin(name ? `${name} ${coordSuffix}` : `WP ${coordSuffix}`);
        } catch {
            // GPS denial/timeouts are ordinary; leave the current origin intact.
        }
    };

    const toggleCheck = useCallback(
        (item: string) => setChecklistState((p) => ({ ...p, [item]: !p[item] })),
        [setChecklistState],
    );

    /**
     * Wipe the planner back to a pristine state:
     *   - Bump the session id so any in-flight enhancement-pipeline
     *     `saveVoyagePlan(...)` calls from a previous calculate are
     *     dropped (saveIfActive guard above).
     *   - Clear the WeatherContext voyagePlan (so the inline map
     *     reverts to the empty placeholder).
     *   - Reset local form fields (origin / destination / via / error
     *     / deepReport).
     *
     * Called from RoutePlanner on mount so each visit starts fresh,
     * even if the previous session's enhancement pipeline is still
     * grinding away in the background.
     */
    const clearVoyagePlan = useCallback(() => {
        if (!isAuthIdentityScopeCurrent(identityScope)) return;
        invalidateUiOperations();
        voyagePlanSession += 1;
        endActiveEnhancementOperation();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        saveVoyagePlan(null as any);
        setOrigin('');
        setDestination('');
        setVia('');
        setError(null);
        setDeepReport(null);
    }, [
        identityScope,
        invalidateUiOperations,
        saveVoyagePlan,
        setDeepReport,
        setDestination,
        setError,
        setOrigin,
        setVia,
    ]);

    const handleMapSelect = async (lat: number, lon: number, name: string) => {
        const operationScope = getAuthIdentityScope();
        if (!sameIdentityScope(operationScope, identityScope) || !isAuthIdentityScopeCurrent(operationScope)) {
            return;
        }
        const lifecycleGeneration = lifecycleGenerationRef.current;
        const requestId = ++operationRequestRef.current.map;
        const selectionTarget = mapSelectionTarget;
        const operationIsCurrent = () =>
            mountedRef.current &&
            lifecycleGeneration === lifecycleGenerationRef.current &&
            requestId === operationRequestRef.current.map &&
            sameIdentityScope(operationScope, identityScope) &&
            isAuthIdentityScopeCurrent(operationScope);
        if (!operationIsCurrent() || !selectionTarget) return;
        // Attempt reverse geocode for a friendly name if only coords provided
        let resolvedName = name;
        if (!name || name.startsWith('WP ') || /^-?\d/.test(name)) {
            try {
                const geoName = await reverseGeocode(lat, lon);
                if (!operationIsCurrent()) return;
                if (geoName) resolvedName = geoName;
            } catch (e) {
                if (!operationIsCurrent()) return;
                // Fallback to WP format
            }
        }
        if (!operationIsCurrent()) return;

        // CRITICAL: Always embed exact coordinates in the display string
        // This ensures the routing pipeline (Gemini + bathymetric + weather)
        // uses the precise GPS position, not a vague name lookup.
        const coordSuffix = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`;
        const displayName = resolvedName ? `${resolvedName} ${coordSuffix}` : `WP ${coordSuffix}`;

        if (selectionTarget === 'origin') {
            setOrigin(displayName);
        } else if (selectionTarget === 'destination') {
            setDestination(displayName);
        } else if (selectionTarget === 'via') {
            setVia(displayName);
        }
        setIsMapOpen(false);
        setMapSelectionTarget(null);
    };

    const openMap = useCallback(
        (target: 'origin' | 'destination' | 'via') => {
            if (!isAuthIdentityScopeCurrent(identityScope)) return;
            operationRequestRef.current.map += 1;
            setMapSelectionTarget(target);
            setIsMapOpen(true);
        },
        [identityScope, setIsMapOpen, setMapSelectionTarget],
    );

    // Computed properties
    const routeCoords = useMemo(() => {
        if (!voyagePlan) return [];
        const waypoints: { lat: number; lon: number }[] = [];
        if (voyagePlan.originCoordinates) waypoints.push(voyagePlan.originCoordinates);
        if (voyagePlan.waypoints && Array.isArray(voyagePlan.waypoints)) {
            voyagePlan.waypoints.forEach((wp) => {
                if (wp && wp.coordinates) waypoints.push(wp.coordinates);
            });
        }
        if (voyagePlan.destinationCoordinates) waypoints.push(voyagePlan.destinationCoordinates);

        if (waypoints.length < 2) return waypoints;

        // Generate a sea route that avoids land masses
        try {
            return generateSeaRoute(waypoints);
        } catch (err) {
            return waypoints;
        }
    }, [voyagePlan]);

    const distVal = useMemo(
        () =>
            voyagePlan && typeof voyagePlan.distanceApprox === 'string'
                ? parseInt(voyagePlan.distanceApprox.match(/(\d+)/)?.[0] || '0', 10)
                : 0,
        [voyagePlan],
    );
    const isShortTrip = distVal < 20;

    return {
        // State
        origin,
        setOrigin,
        destination,
        setDestination,
        via,
        setVia,
        departureDate,
        setDepartureDate,
        handleDateChange,
        isMapOpen,
        setIsMapOpen,
        mapSelectionTarget,
        setMapSelectionTarget,
        loading,
        loadingStep,
        error,
        setError,
        analyzingDeep,
        deepReport,
        checklistState,
        toggleCheck,

        // Handlers
        handleCalculate,
        handleDeepAnalysis,
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

        // Computed
        routeCoords,
        isShortTrip,
        activeChecklistTab,
        setActiveChecklistTab,
        minDate: useMemo(() => new Date().toLocaleDateString('en-CA'), []),

        // Context
        voyagePlan,
        vessel,
        usingDefaultVessel,
        isPro,
        mapboxToken,
        hourlyForecasts: useMemo(() => weatherData?.hourly || [], [weatherData?.hourly]),
    };
};
