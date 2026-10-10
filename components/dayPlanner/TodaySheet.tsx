/**
 * Plan Your Day — "Today on the water" (build 124).
 *
 * Shane, 2026-10-08: "ok, can you revamp the plan your day thing, it does
 * nothing of use at the moment claude. make it work please ;)". It opens
 * straight onto today wherever the boat is, with no form:
 *
 *   - the morning, afternoon and evening, each Inside / Near / Over the
 *     skipper's own limits, from seven models at one point, and whether
 *     they agree (a glyph and a word, never colour alone);
 *   - one headline, the light, and the next high and low water;
 *   - the best two or three stops within a day's sail, each with leave,
 *     there and home times from her polar in the forecast wind (the routers'
 *     own polar since build 125: services/routingPolar);
 *   - All places, every one with a plain reason when it is not today.
 *
 * A stop's detail says how each time was worked out; "Plot on chart" sets
 * the Plan page's departure and opens the Manual plotter with straight pins
 * (both ⚡ buttons are parked). Since 127-PYD-2 the stop she opens can be
 * routed round the land, on a tap, through Auto's own provider and behind
 * Auto route (trial): his account only in 127 (pydRouting.ts), one route at a
 * time, in this sheet's memory only (stopRoute.ts), and the owner sees how
 * long it took. It never saves, never expires and never blocks: cautions, not
 * blocks.
 *
 * Everything it shows is worked out by services/dayPlanner/today.ts (pure)
 * from what services/dayPlanner/todayLoader.ts fetched; times are the
 * PLACE's own clock. `io` swaps the sources for fixtures and tests only.
 *
 * Say why (build 127, 127-PYD-1): a ✕ or ? row shows its reason where its
 * times were; ✓ ≈ ✕ ? always mean her limits (the day chips too, never the
 * models' agreement glyphs); line icons, not emoji; "Local notes", not
 * "Parks", on a reviewed stop.
 *
 * Different places (127-PYD-4): the card is the best fit, the best the other
 * way and one somewhere different, each but the first tagged ("Other way",
 * "New to you" …) where "Local notes" sat. Five get the weather along the way;
 * their pins are checked against her charts and her voyage ends are read on
 * the phone, both kept in this sheet's memory only. An open stop keeps its slot.
 */
import React, { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { VesselProfile } from '../../types/vessel';
import type { PlotDayAction } from '../../services/deepLink';
import type { BoatFix } from '../../services/boatPositionChain';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { plannerFixAge, readPlannerVesselPosition } from '../../services/plannerVesselPosition';
import { setPlanDeparture } from '../../services/planDeparture';
import { routingSpeedModel } from '../../services/routingPolar';
import { useRoutingPolar } from '../../hooks/useRoutingPolar';
import { closeHauledDegFor } from '../../services/sailing/pointOfSail';
import { vesselCruisingSpeedKts, vesselDraftMetres } from '../../services/units';
import { getCachedSummaries } from '../../services/shiplog/VoyageSummaryCache';
import type { PassageSpeedModel } from '../../services/passagePlan';
import { openExternalUrl } from '../../services/externalLinks';
import { usePassageSpeedPref } from '../../stores/passageHudStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindStore } from '../../stores/WindStore';
import { officialWarningsSource } from '../../utils/officialWarningsSource';
import { DEFAULT_VESSEL } from '../../utils/defaultVessel';
import { PASSAGE_MODEL_CHOICES, passageModelChoice } from '../passage/PassageModelModal';
import { DeviceIcon, LightningBoltIcon, MapPinIcon, SailBoatIcon } from '../Icons';
import { formatLatLon, type LatLon, type RoutedLeg } from '../../services/dayPlanner/places';
import { PYD_ROUTE_ON_OPEN, pydRoutingAudience, readOwnerAccount } from '../../services/dayPlanner/pydRouting';
import {
    routeStop,
    stopRouteGate,
    stopRouteKey,
    stopRouteQueue,
    type StopRouteAction,
    type StopRouteRequest,
    type StopRouteResult,
} from '../../services/dayPlanner/stopRoute';
import { isDraftConfirmed } from '../../services/draftConfirmation';
import { requireConfirmedDraft } from '../../stores/draftConfirmStore';
import {
    DEFAULT_STAY,
    STAY_OPTIONS,
    dayMonth,
    partCell,
    planDay,
    plotDayAction,
    resolveDayPlanLimits,
    stayChipLabel,
    stayMenuLabel,
    type DayPlanView,
    type Notice,
    type StayOption,
    type StopLegs,
    type StopRow,
} from '../../services/dayPlanner/today';
import { voyageEnds, type PinResult } from '../../services/dayPlanner/pick';
import {
    isPlanCancelled,
    loadLandingWindow,
    loadStopLegs,
    loadToday,
    routeWindModels,
    todayInput,
    type TodayBase,
    type TodayLoaderDeps,
} from '../../services/dayPlanner/todayLoader';
import { TodayModal } from './TodayModal';
import { TodayStopDetail, type LandingLoader, type StopRouteView } from './TodayStopDetail';
import { lazyRetry } from '../../utils/lazyRetry';
import { snapshotAutoroutingVesselProfile } from '../../services/autoroutingVesselProfile';
import type { AutoroutingTrialRoute } from '../../types/autorouting';

// Auto's chart, over Plan Your Day for a routed stop (127-PYD-3): lazy, as RoutingModeDialog loads it.
const DayChart = lazyRetry(
    () =>
        import('../autorouting/AutoroutingTrialWorkspace').then((module) => ({
            default: module.AutoroutingTrialWorkspace,
        })),
    'AutoroutingTrialWorkspace',
);
import {
    TodayPlacePicker,
    readPhonePosition,
    savedPlanPlaces,
    type PlacePickerIO,
    type PlanStart,
} from './TodayPlacePicker';
import { TodaySources, shortCredit } from './TodaySources';
import './DayPlanner.css';

/** The sources the sheet reads, swapped only by fixtures and tests. */
export interface TodaySheetIO extends PlacePickerIO {
    loader?: Partial<TodayLoaderDeps>;
    readBoat?: () => Promise<BoatFix | null>;
    /** Where her voyages ended, on the phone; null when her history is not known. */
    voyageEnds?: () => Promise<LatLon[] | null>;
    /** Her charts at these pins, in memory (EncHazardService.queryHazards). */
    pinDepths?: (points: readonly LatLon[]) => Promise<PinResult[]>;
    /** Whether this is the owner's account (pydRouting.readOwnerAccount), read once per open. */
    ownerAccount?: () => Promise<boolean>;
    /** One stop's route (stopRoute.routeStop over Auto's provider); fixtures swap the provider. */
    routeStop?: (
        req: StopRouteRequest,
        opts: { signal: AbortSignal; onProgress?: (words: string) => void },
    ) => Promise<StopRouteResult>;
    /** PYD_ROUTE_ON_OPEN, for a fixture or test. */
    routeOnOpen?: boolean;
}

export interface TodaySheetProps {
    /** Always resolved: her profile, or the default boat. */
    vessel: VesselProfile;
    usingDefaultVessel: boolean;
    onClose: () => void;
    onPlot: (action: PlotDayAction) => void;
    /** Settings → Vessel, for the default-boat notice. */
    onOpenVessel?: () => void;
    /** For Auto's chart over a routed stop (127-PYD-3). */
    mapboxToken?: string;
    io?: TodaySheetIO;
}

type Screen = null | 'picker' | 'places' | 'sources' | { stop: string };

const PART_LABELS = ['Morning', 'Afternoon', 'Evening'] as const;
const lowerFirst = (text: string) => (text ? text[0].toLowerCase() + text.slice(1) : text);

const startLabel = (start: PlanStart): string | null =>
    start.kind === 'saved' || start.kind === 'typed' ? start.name : null;

function startAge(start: PlanStart, nowMs: number): string {
    if (start.kind === 'boat') return plannerFixAge(start.fix, nowMs);
    if (start.kind === 'phone') return 'this phone';
    if (start.kind === 'saved') return start.home ? 'home port' : 'saved place';
    return 'typed place';
}

export default function TodaySheet({
    vessel,
    usingDefaultVessel,
    onClose,
    onPlot,
    onOpenVessel,
    mapboxToken = '',
    io,
}: TodaySheetProps) {
    const [scope] = useState(getAuthIdentityScope);
    // The sources, fixed for the sheet's life.
    const [sources] = useState(() => ({
        loader: io?.loader,
        now: io?.loader?.now ?? (() => Date.now()),
        readBoat: io?.readBoat ?? readPlannerVesselPosition,
        picker: { readPhone: io?.readPhone, geocode: io?.geocode } as PlacePickerIO,
        voyageEnds: io?.voyageEnds ?? (() => getCachedSummaries(scope).then(voyageEnds)),
        pinDepths:
            io?.pinDepths ??
            ((points: readonly LatLon[]) =>
                import('../../services/enc/EncHazardService').then((enc) => enc.queryHazards([...points]))),
        ownerAccount: io?.ownerAccount ?? (() => readOwnerAccount(scope)),
        routeStop: io?.routeStop ?? routeStop,
        routeOnOpen: io?.routeOnOpen ?? PYD_ROUTE_ON_OPEN,
    }));
    // The stop she opens, routed (127-PYD-2): one at a time, in this sheet's memory only.
    const [owner, setOwner] = useState(false);
    const [, routesChanged] = useReducer((n: number) => n + 1, 0);
    const [queue] = useState(() =>
        stopRouteQueue(sources.routeStop, routesChanged, { current: () => isAuthIdentityScopeCurrent(scope) }),
    );
    /** The route whose draft ask she closed: its row says so, and the next tap asks again. */
    const [asked, setAsked] = useState<string | null>(null);
    const [boat, setBoat] = useState<BoatFix | null | 'reading'>('reading');
    const [start, setStart] = useState<PlanStart | null>(null);
    const [base, setBase] = useState<TodayBase | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [legs, setLegs] = useState<ReadonlyMap<string, StopLegs>>(() => new Map());
    const [date, setDate] = useState<string | null>(null);
    const [stay, setStay] = useState<StayOption>(DEFAULT_STAY);
    const [screen, setScreen] = useState<Screen>(null);
    const [pickerFocus, setPickerFocus] = useState<'list' | 'type'>('list');
    const [visited, setVisited] = useState<LatLon[] | null>(null);
    const [pinDepth, setPinDepth] = useState<ReadonlyMap<string, PinResult>>(() => new Map());
    const requested = useRef(new Set<string>());
    const legsAbort = useRef<AbortController | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    // ── The boat, her limits and her speed ──
    const settings = useSettingsStore((st) => st.settings);
    const boatProfile = vessel ?? DEFAULT_VESSEL;
    const limits = useMemo(
        () => resolveDayPlanLimits(settings.comfortParams, boatProfile, usingDefaultVessel),
        [settings.comfortParams, boatProfile, usingDefaultVessel],
    );
    const speedPref = usePassageSpeedPref();
    // The routers' own polar (build 125, 125-08), as the passage HUD sails it:
    // her imported, typed-in or learned figures as given, a database or
    // generic shape scaled to her cruising speed. The learned grid is read
    // after the first paint, through the resolver.
    const routing = useRoutingPolar(boatProfile);
    const speed = useMemo<PassageSpeedModel>(
        () =>
            routingSpeedModel(routing, {
                mode: speedPref,
                cruiseKts: vesselCruisingSpeedKts(boatProfile, 6),
                isSail: boatProfile.type === 'sail',
                closeHauledDeg: closeHauledDegFor(boatProfile),
            }),
        [routing, speedPref, boatProfile],
    );
    const cruiseRef = useRef(speed.cruiseKts);
    cruiseRef.current = speed.cruiseKts;
    const savedPlaces = useMemo(() => savedPlanPlaces(settings), [settings]);
    const savedRef = useRef(savedPlaces);
    savedRef.current = savedPlaces;
    // The chart's own wind model heads each stop's route, as the passage HUD's does.
    const [wind] = useState(() =>
        routeWindModels(PASSAGE_MODEL_CHOICES, passageModelChoice(WindStore.getState().model)),
    );

    // ── Close on an account change; read the boat and her voyage ends once ──
    useEffect(() => {
        const stop = subscribeAuthIdentityScope(() => {
            if (!isAuthIdentityScopeCurrent(scope)) onCloseRef.current();
        });
        let live = true;
        sources
            .readBoat()
            .catch(() => null)
            .then((fix) => {
                if (!live || !isAuthIdentityScopeCurrent(scope)) return;
                setBoat(fix);
                if (fix) setStart((s) => s ?? { kind: 'boat', lat: fix.latitude, lon: fix.longitude, fix });
            });
        sources
            .voyageEnds()
            .catch(() => null)
            .then((ends) => {
                if (live && isAuthIdentityScopeCurrent(scope)) setVisited(ends);
            });
        sources
            .ownerAccount()
            .catch(() => false)
            .then((yes) => {
                if (live && isAuthIdentityScopeCurrent(scope)) setOwner(yes);
            });
        return () => {
            live = false;
            stop();
        };
    }, [scope, sources]);

    // ── Load the place whenever the start changes ──
    useEffect(() => {
        if (!start) return;
        const controller = new AbortController();
        legsAbort.current = new AbortController();
        requested.current = new Set();
        setBase(null);
        setLegs(new Map());
        setPinDepth(new Map());
        setLoadError(null);
        setDate(null);
        loadToday(
            {
                start: { lat: start.lat, lon: start.lon },
                label: startLabel(start),
                savedPlaces: savedRef.current,
                cruiseKts: cruiseRef.current,
            },
            { signal: controller.signal, onUpdate: setBase, deps: sources.loader },
        ).catch((error: unknown) => {
            if (isPlanCancelled(error)) return;
            setLoadError(error instanceof Error ? error.message : 'This place could not be planned.');
        });
        return () => {
            controller.abort();
            legsAbort.current?.abort();
            // A new start, or the sheet closing: its routes stop and are forgotten.
            queue.clear();
        };
    }, [start, sources, queue]);

    const boatFixAgeMs = start?.kind === 'boat' ? sources.now() - start.fix.timestamp : null;
    const pinned = screen && typeof screen === 'object' ? screen.stop : null;
    // The default boat's draft is a guess, and so is the 2.5 m stand-in for a draft she never set:
    // her pins are not checked against either.
    const draftM = usingDefaultVessel ? null : vesselDraftMetres(boatProfile, 0) || null;
    // The boat a route is asked for: the one the draft modal confirms (the store's), else hers.
    const routeVessel = settings.vessel ?? boatProfile;
    const routeDraftM = vesselDraftMetres(routeVessel, 0);
    // The routed stops for this start and draft. A new map only when one lands, never on a progress word,
    // so the plan is worked out again only then.
    const routed = [...queue.states].flatMap(([key, route]) =>
        route.kind === 'routed' && start && key === stopRouteKey(route.id, start, routeDraftM)
            ? [[route.id, route.leg] as const]
            : [],
    );
    const routedKey = routed.map(([id]) => id).join('|');
    const routes = useMemo(
        () => new Map<string, RoutedLeg>(routed),
        // routedKey stands for the routed stops.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [routedKey],
    );
    const view: DayPlanView | null = useMemo(
        () =>
            base
                ? planDay(
                      todayInput(base, {
                          stay,
                          limits,
                          speed,
                          usingDefaultVessel,
                          date,
                          legs,
                          boatFixAgeMs,
                          windModel: wind.preferred,
                          visited,
                          pinned,
                          pinDepth,
                          draftM,
                          routes,
                      }),
                  )
                : null,
        [
            base,
            stay,
            limits,
            speed,
            usingDefaultVessel,
            date,
            legs,
            boatFixAgeMs,
            wind,
            visited,
            pinned,
            pinDepth,
            draftM,
            routes,
        ],
    );

    // ── Route forecasts for the stops the engine names (each once per place), and her charts at
    //    their pins (127-PYD-4: memory only, never the default boat's guessed draft) ──
    const needKey = view?.needsLegs.map((n) => n.id).join('|') ?? '';
    useEffect(() => {
        if (!view || !legsAbort.current) return;
        const signal = legsAbort.current.signal;
        const missing = view.needsLegs.filter((n) => !requested.current.has(n.id));
        if (!missing.length) return;
        for (const n of missing) requested.current.add(n.id);
        loadStopLegs(missing, wind, {
            signal,
            deps: sources.loader,
            onLegs: (id, stopLegs) => setLegs((prev) => new Map(prev).set(id, stopLegs)),
        }).catch(() => {
            /* cancelled: the sheet closed or the place changed */
        });
        if (draftM !== null)
            sources
                .pinDepths(missing.map((n) => view.rows.get(n.id)!.candidate))
                .then((results) => {
                    if (!signal.aborted && isAuthIdentityScopeCurrent(scope))
                        setPinDepth((prev) => {
                            const next = new Map(prev);
                            missing.forEach((n, i) => results[i] && next.set(n.id, results[i]));
                            return next;
                        });
                })
                .catch(() => {
                    /* no charts answered: "depth not checked" */
                });
        // needKey stands for view.needsLegs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needKey, wind, sources]);

    // The wind along a routed line, once (127-PYD-2): its rows then walk the route, not the estimate.
    // Failed, it is asked once more the next time a stop page opens or closes.
    useEffect(() => {
        if (!legsAbort.current) return;
        const asked = requested.current;
        const missing = [...routes]
            .map(([id, leg]) => ({ id: `${id}#routed`, coords: leg.route.points }))
            .filter((n) => !asked.has(n.id));
        if (!missing.length) return;
        for (const n of missing) asked.add(n.id);
        loadStopLegs(missing, wind, {
            signal: legsAbort.current.signal,
            deps: sources.loader,
            onLegs: (id, stopLegs) => {
                if (stopLegs.failed && !asked.has(`${id}!`)) {
                    asked.add(`${id}!`);
                    asked.delete(id);
                }
                setLegs((prev) => new Map(prev).set(id, stopLegs));
            },
        }).catch(() => {
            /* cancelled: the sheet closed or the place changed */
        });
    }, [routes, wind, sources, pinned]);

    const chooseStart = useCallback((next: PlanStart) => {
        setScreen(null);
        setStart(next);
    }, []);

    const openPicker = (focus: 'list' | 'type' = 'list') => {
        setPickerFocus(focus);
        setScreen('picker');
    };

    // Never a straight line (127-PYD-3): the routed line, her saved route, or the two marks and why.
    const plot = (row: StopRow, departureMs: number | null, routed?: AutoroutingTrialRoute) => {
        if (!base) return;
        if (departureMs !== null) setPlanDeparture(departureMs, scope);
        const state = openKey ? queue.states.get(openKey) : undefined;
        onPlot(
            plotDayAction(base.start, row.candidate, stay, {
                routed: routed?.coordinates.map(([lon, lat]) => ({ lat, lon })),
                why: state?.kind === 'no-route' ? state.words : '',
            }),
        );
    };
    // Auto's chart over Plan Your Day: the routed proposal at her chosen leave (no re-route).
    const [dayChart, setDayChart] = useState<{ proposal: AutoroutingTrialRoute; departureMs: number | null } | null>(
        null,
    );
    const showRoute = (departureMs: number | null) => {
        const state = openKey ? queue.states.get(openKey) : undefined;
        if (state?.kind !== 'routed') return;
        const leave = departureMs ?? state.proposal.departureMs ?? null;
        setDayChart({
            proposal: { ...state.proposal, ...(leave !== null ? { departureMs: leave } : {}) },
            departureMs,
        });
    };
    const closeDayChart = () => {
        setDayChart(null);
        // Back on her stop page, on the button that opened the chart.
        requestAnimationFrame(() =>
            document.querySelector<HTMLElement>('.today-detail .today-primary')?.focus({ preventScroll: true }),
        );
    };

    const loadLanding: LandingLoader = useCallback(
        (stop, window, stayTimes, signal) =>
            loadLandingWindow(stop, window, stayTimes, { signal, deps: sources.loader }),
        [sources],
    );

    const nowMs = base?.nowMs ?? sources.now();
    const warnings = officialWarningsSource(start?.lat ?? null, start?.lon ?? null);
    const placeName = base?.start.name ?? (start ? (startLabel(start) ?? formatLatLon(start.lat, start.lon)) : null);
    const locating = !start && boat === 'reading';
    const noPosition = !start && boat !== 'reading';

    const onNotice = (notice: Notice) => {
        if (notice.kind === 'old-fix') openPicker();
        else if (notice.kind === 'default-boat') onOpenVessel?.();
        else if (notice.kind === 'cyclone') void openExternalUrl(warnings.url);
    };

    // Found by id among every checked row, so a stop whose page is open never closes under her.
    const detailRow = pinned && view ? (view.rows.get(pinned) ?? null) : null;

    // ── Route round the land (127-PYD-2): her saved route still wins; a tester is offered nothing ──
    const gate = stopRouteGate({
        audience: pydRoutingAudience(owner),
        signedIn: !!scope.userId,
        defaultBoat: usingDefaultVessel,
        switchOn: settings.autorouteTrialEnabled === true,
        draftConfirmed: isDraftConfirmed(settings.vessel),
    });
    const openKey = pinned && start ? stopRouteKey(pinned, start, routeDraftM) : null;
    const offered = !!detailRow && (gate.ok || !!gate.words) && detailRow.candidate.distance.basis !== 'saved';
    const startRoute = (row: StopRow, departureMs: number | null) => {
        if (!start || !base || !(gate.ok || gate.action === 'confirm-draft')) return;
        const key = openKey;
        const go = () => {
            // Read after the draft modal: a draft changed there is the one routed.
            const vessel = useSettingsStore.getState().settings.vessel ?? boatProfile;
            const draft = vesselDraftMetres(vessel, 0);
            queue.request(stopRouteKey(row.id, start, draft), {
                id: row.id,
                start,
                stop: row.candidate,
                startName: base.start.name,
                stopName: row.name.split(' · ')[0],
                draftM: draft,
                speedKts: speed.cruiseKts,
                vessel,
                // A leave gone by while the sheet stayed open is now: the line is the same, only the tide hour moves.
                departureMs: Math.max(departureMs ?? 0, sources.now()),
            });
        };
        if (gate.ok) go();
        else
            void requireConfirmedDraft('day-plan').then((yes) => {
                // Nothing starts for a page or a sheet that has closed, or for another account.
                if (!mounted.current || !isAuthIdentityScopeCurrent(scope) || pinnedRef.current !== row.id) return;
                setAsked(yes ? null : key);
                if (yes) go();
            });
    };
    const pinnedRef = useRef(pinned);
    pinnedRef.current = pinned;
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const startRef = useRef(startRoute);
    startRef.current = startRoute;
    const autoStart = sources.routeOnOpen && offered && gate.ok;
    // Closing her page ends its route (127-ROUTE-W stops the worker); with route-on-open, opening starts it.
    useEffect(() => {
        if (!openKey) return;
        if (autoStart && detailRow && !queue.states.has(openKey))
            startRef.current(detailRow, detailRow.plan?.best?.departureMs ?? null);
        return () => queue.cancel(openKey);
        // detailRow is read at open only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openKey, autoStart, queue]);
    const onRouteAction = (action: StopRouteAction) => {
        if (action === 'vessel') onOpenVessel?.();
        // The same Preferences switch, turned on in place: her page stays open.
        else if (action === 'preferences')
            void useSettingsStore.getState().updateSettings({ autorouteTrialEnabled: true });
    };
    const allCount = view ? view.fits.length + view.unchecked.length + view.notToday.length : 0;
    // Places: still asked (none in yet), or none could be read. Never the
    // "fits" copy over an empty list that is only empty because it failed.
    const placesLine =
        start && base && !base.places
            ? base.placesStatus === 'failed'
                ? "Places didn't load: OpenStreetMap didn't answer."
                : 'Finding places…'
            : null;
    const headline = loadError
        ? { text: loadError }
        : locating
          ? { text: 'Finding the boat…' }
          : noPosition
            ? { text: 'Where are you planning from?' }
            : view
              ? view.headline
              : { text: `Checking 7 models for ${placeName}…` };

    return (
        <>
            <TodayModal
                title="Plan Your Day"
                layer="modal"
                active={screen === null}
                hidden={!!dayChart}
                onClose={onClose}
                className="today-main"
                headerBody={
                    <button
                        type="button"
                        className="today-place"
                        aria-haspopup="dialog"
                        aria-label={
                            start && placeName
                                ? // Whose age it is (127-PYD-1): the boat line icon shows it, VoiceOver says it.
                                  `Plan from: ${placeName}, ${start.kind === 'boat' ? 'boat ' : ''}${startAge(start, nowMs)}`
                                : 'Plan from: choose a place'
                        }
                        disabled={locating}
                        onClick={() => openPicker()}
                    >
                        {start?.kind === 'boat' || locating ? (
                            <SailBoatIcon className="today-ico" />
                        ) : start?.kind === 'phone' ? (
                            <DeviceIcon className="today-ico" />
                        ) : (
                            <MapPinIcon className="today-ico" />
                        )}
                        <span className="today-ellipsis">
                            {locating
                                ? 'Finding the boat…'
                                : start && placeName
                                  ? `${placeName} · ${startAge(start, nowMs)}`
                                  : 'Choose a place'}
                        </span>
                        <span aria-hidden="true">▾</span>
                    </button>
                }
                headerExtra={
                    <button
                        type="button"
                        className="today-icon"
                        aria-label="Sources and limits"
                        aria-haspopup="dialog"
                        disabled={!base}
                        onClick={() => setScreen('sources')}
                    >
                        <span aria-hidden="true">ⓘ</span>
                    </button>
                }
                footer={
                    // With no place yet, everything else waits (the three ways to choose one).
                    start && (
                        <div className="today-foot">
                            <div className="today-foot-row">
                                <button
                                    type="button"
                                    className="today-link"
                                    aria-haspopup="dialog"
                                    disabled={!view || !base?.places}
                                    onClick={() => setScreen('places')}
                                >
                                    All places <span className="today-nowrap">({allCount}) ›</span>
                                </button>
                                <button
                                    type="button"
                                    className="today-link"
                                    aria-label={`${warnings.name} warnings, opens outside the app`}
                                    onClick={() => void openExternalUrl(warnings.url)}
                                >
                                    {/* A long issuer name ("MeteoAlarm", "Environment Canada")
                                        wraps before "warnings ↗", never before the arrow. */}
                                    {warnings.shortName} <span className="today-nowrap">warnings ↗</span>
                                </button>
                            </div>
                            <p className="today-credit" data-testid="day-plan-credit">
                                {shortCredit(base, legs)}
                            </p>
                        </div>
                    )
                }
            >
                <div className="today-col-a">
                    {start && (
                        <div className="today-controls">
                            <div role="group" aria-label="Day" className="today-days">
                                {(view?.chips ?? []).map((chip) => (
                                    <button
                                        key={chip.date}
                                        type="button"
                                        className="today-chip"
                                        aria-pressed={chip.date === view?.date}
                                        aria-label={chip.ariaLabel}
                                        onClick={() => setDate(chip.date)}
                                    >
                                        {chip.glyph && (
                                            <span aria-hidden="true" className="today-glyph" data-level={chip.best}>
                                                {chip.glyph}
                                            </span>
                                        )}
                                        {chip.label}
                                    </button>
                                ))}
                            </div>
                            <span className="today-chip today-stay">
                                <span aria-hidden="true">{stayChipLabel(stay)}</span>
                                <select
                                    aria-label="Stay"
                                    value={stay}
                                    onChange={(e) => setStay(e.target.value as StayOption)}
                                >
                                    {STAY_OPTIONS.map((option) => (
                                        <option key={option} value={option}>
                                            {stayMenuLabel(option)}
                                        </option>
                                    ))}
                                </select>
                            </span>
                        </div>
                    )}
                    {start && (
                        <ul aria-label="The day" className="today-verdict">
                            {PART_LABELS.map((label, i) => {
                                const part = view?.parts[i];
                                // While the models load the cells wait; "No forecast" would be false.
                                if (!part || !base || base.weather === 'loading')
                                    return (
                                        <li
                                            key={label}
                                            className="today-cell"
                                            data-level="loading"
                                            aria-label={`${label}: checking`}
                                        >
                                            <span className="today-cell-label">{label}</span>
                                            <span className="today-cell-wind">…</span>
                                            <span className="today-cell-word">{'\u00a0'}</span>
                                        </li>
                                    );
                                const cell = partCell(part, base.atmos?.models.length ?? 0);
                                return (
                                    <li
                                        key={label}
                                        className="today-cell"
                                        data-level={part.level}
                                        aria-label={cell.ariaLabel}
                                    >
                                        <span className="today-cell-label">{cell.label}</span>
                                        <span className="today-cell-wind">
                                            {/* The bolt is drawn, not the emoji: it keeps ≈'s width in the tile. */}
                                            <span aria-hidden="true">
                                                {cell.glyph === '⚡' ? (
                                                    <LightningBoltIcon className="today-bolt" />
                                                ) : (
                                                    cell.glyph
                                                )}
                                            </span>
                                            {cell.wind ? ` ${cell.wind}` : ''}
                                        </span>
                                        <span className="today-cell-word">{cell.word}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <p className="today-headline" data-testid="day-plan-headline" aria-live="polite">
                        {headline.text}
                        {'link' in headline && headline.link && (
                            <>
                                {' '}
                                <button
                                    type="button"
                                    className="today-inline-link"
                                    onClick={() => setDate(headline.link!.date)}
                                >
                                    {headline.link.label}
                                </button>
                            </>
                        )}
                    </p>
                    {noPosition && (
                        <div className="today-where">
                            <PhoneButton io={sources.picker} onStart={chooseStart} />
                            <button type="button" className="today-button" onClick={() => openPicker('list')}>
                                Saved place
                            </button>
                            <button type="button" className="today-button" onClick={() => openPicker('type')}>
                                Type a place
                            </button>
                        </div>
                    )}
                </div>
                {start && (
                    <div className="today-col-b">
                        <p className="today-facts" data-testid="day-plan-facts" aria-label={view?.facts.ariaLabel}>
                            {view?.facts.text ?? ' '}
                        </p>
                        {view?.notices.top && <NoticeLine notice={view.notices.top} onAct={onNotice} />}
                        {placesLine && (
                            <p
                                className={base?.placesStatus === 'failed' ? 'today-notice' : 'today-facts'}
                                role="status"
                                data-testid="day-plan-places"
                            >
                                {placesLine}
                            </p>
                        )}
                        {view && view.top.length > 0 && view.state !== 'no-daylight' && (
                            <ul aria-label="Stops" className="today-stops">
                                {view.top.map((row) => (
                                    <li key={row.id}>
                                        <StopButton row={row} card onOpen={() => setScreen({ stop: row.id })} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </TodayModal>

            {screen === 'picker' && (
                <TodayPlacePicker
                    boat={boat === 'reading' ? null : boat}
                    signedIn={!!scope.userId}
                    nowMs={sources.now()}
                    current={start}
                    currentName={placeName}
                    saved={savedPlaces}
                    focus={pickerFocus}
                    io={sources.picker}
                    onStart={chooseStart}
                    onClose={() => setScreen(null)}
                />
            )}
            {screen === 'sources' && base && (
                <TodaySources
                    base={base}
                    view={view}
                    limits={limits}
                    legs={legs}
                    wind={wind}
                    warnings={warnings}
                    onClose={() => setScreen(null)}
                />
            )}
            {screen === 'places' && view && base && (
                <AllPlaces
                    view={view}
                    base={base}
                    onOpen={(id) => setScreen({ stop: id })}
                    onClose={() => setScreen(null)}
                />
            )}
            {detailRow && view && base && (
                <TodayStopDetail
                    key={detailRow.id}
                    row={detailRow}
                    view={view}
                    stay={stay}
                    speed={speed}
                    polarIsOwn={routing.source !== 'default'}
                    polar={routing}
                    leavingMarina={!!base.marina}
                    loadLanding={detailRow.candidate.reviewed?.landingTide ? loadLanding : null}
                    onPlot={(departureMs) => plot(detailRow, departureMs)}
                    onBack={() => setScreen(null)}
                    hidden={!!dayChart}
                    route={
                        offered && openKey
                            ? {
                                  state: queue.states.get(openKey),
                                  // A draft she has not confirmed is asked on the tap; said only once she closed the ask.
                                  blocked:
                                      !gate.ok && (gate.action !== 'confirm-draft' || asked === openKey)
                                          ? (gate as StopRouteView['blocked'])
                                          : null,
                                  owner,
                                  draftM: routeDraftM,
                                  onRoute: (departureMs) => startRoute(detailRow, departureMs),
                                  onShow: showRoute,
                                  onAction: onRouteAction,
                              }
                            : null
                    }
                />
            )}
            {dayChart && detailRow && (
                <Suspense
                    fallback={
                        <p role="status" className="today-notice">
                            Opening chart…
                        </p>
                    }
                >
                    <DayChart
                        mapboxToken={mapboxToken}
                        initialDraftM={routeDraftM}
                        initialSpeedKts={routeVessel.cruisingSpeed}
                        initialVesselProfile={snapshotAutoroutingVesselProfile(routeVessel)}
                        onClose={closeDayChart}
                        dayPlan={{
                            proposal: dayChart.proposal,
                            stopName: detailRow.name.split(' · ')[0],
                            onUseOnMainChart: (route) => {
                                setDayChart(null);
                                plot(detailRow, dayChart.departureMs, route);
                            },
                        }}
                    />
                </Suspense>
            )}
        </>
    );
}

function NoticeLine({ notice, onAct }: { notice: Notice; onAct: (notice: Notice) => void }) {
    const actionable = notice.kind === 'old-fix' || notice.kind === 'default-boat' || notice.kind === 'cyclone';
    if (!actionable)
        return (
            <p className="today-notice" role="status">
                {notice.text}
            </p>
        );
    return (
        <button type="button" className="today-notice today-notice-button" onClick={() => onAct(notice)}>
            {notice.text}
        </button>
    );
}

function StopButton({ row, card, onOpen }: { row: StopRow; card?: boolean; onOpen: () => void }) {
    return (
        <button
            type="button"
            className="today-stop"
            data-level={row.level ?? 'unknown'}
            aria-haspopup="dialog"
            aria-label={row.ariaLabel}
            onClick={onOpen}
        >
            <span aria-hidden="true" className="today-stop-glyph">
                {row.glyph}
            </span>
            <span className="today-stop-text">
                <span className="today-stop-l1">
                    {/* A reviewed stop's own name ("Cid Harbour · Sawmill Beach") is
                        shortened here to its place; the detail shows it whole. */}
                    <span className="today-stop-name">{row.name.split(' · ')[0]}</span>
                    <span className="today-stop-shelter">&nbsp;· {row.shelter}</span>
                    {/* The pick's tag wins on the card (127-PYD-4); "Local notes" everywhere else. */}
                    {card && row.tag ? (
                        <span className="today-tag today-pick">{row.tag}</span>
                    ) : (
                        row.parks && <span className="today-tag">Local notes</span>
                    )}
                </span>
                {/* A ✕ or ? row says why where its times were (127-PYD-1); a routed stop's times wear the route mark. */}
                <span className="today-stop-l2">
                    {row.route === 'routed' && !row.line2Reason && (
                        <span aria-hidden="true" className="today-route-mark">
                            ↝{' '}
                        </span>
                    )}
                    {row.line2Reason ?? row.line2}
                </span>
            </span>
            <span aria-hidden="true" className="today-chevron">
                ›
            </span>
        </button>
    );
}

function PhoneButton({ io, onStart }: { io: PlacePickerIO; onStart: (start: PlanStart) => void }) {
    const [state, setState] = useState<'idle' | 'reading' | 'none'>('idle');
    return (
        <button
            type="button"
            className="today-button"
            disabled={state === 'reading'}
            onClick={async () => {
                setState('reading');
                const at: LatLon | null = await (io.readPhone ?? readPhonePosition)().catch(() => null);
                if (at) onStart({ kind: 'phone', lat: at.lat, lon: at.lon });
                else setState('none');
            }}
        >
            {state === 'reading'
                ? 'Finding this phone…'
                : state === 'none'
                  ? 'No position on this phone'
                  : 'This phone'}
        </button>
    );
}

function AllPlaces({
    view,
    base,
    onOpen,
    onClose,
}: {
    view: DayPlanView;
    base: TodayBase;
    onOpen: (id: string) => void;
    onClose: () => void;
}) {
    const day = view.isToday ? 'today' : view.dayName;
    const swept = view.rows;
    // An OpenStreetMap place over a day old carries the date it was mapped.
    const mapped = (id: string) => {
        const at = base.places?.candidates.find((x) => x.id === id)?.mappedAtMs;
        return at === undefined ? null : `mapped ${dayMonth(at, base.zone)}`;
    };
    const row = (r: StopRow) =>
        swept.has(r.id) ? (
            <li key={r.id}>
                <StopButton row={r} onOpen={() => onOpen(r.id)} />
            </li>
        ) : (
            <li key={r.id} className="today-place-line">
                {r.name} · {r.shelter} · {lowerFirst(r.line2)}
                {r.kind ? ` · ${lowerFirst(r.kind)}` : ''}
                {r.mapped ? ` · ${r.mapped}` : ''}
            </li>
        );
    return (
        <TodayModal title={`Places near ${base.start.name}`} onClose={onClose} className="today-list-card">
            {base.placesStatus === 'loading' && (
                <p className="today-place-line" role="status">
                    Still asking OpenStreetMap for more places…
                </p>
            )}
            {base.placesStatus === 'partial' && (
                <p className="today-place-line">Part of the area didn&rsquo;t load: this list may be short.</p>
            )}
            <h3 className="today-h3">Fits {day}</h3>
            {view.fits.length ? (
                <ul className="today-stops">{view.fits.map(row)}</ul>
            ) : (
                <p className="today-place-line">
                    Nothing {view.unchecked.length ? 'checked so far ' : ''}fits {day}.
                </p>
            )}
            {view.unchecked.length > 0 && (
                <>
                    <h3 className="today-h3">Weather not checked</h3>
                    <ul className="today-stops">{view.unchecked.map(row)}</ul>
                </>
            )}
            <h3 className="today-h3">Not {day}</h3>
            {view.notToday.length ? (
                <ul>
                    {view.notToday.map((r) => (
                        <li key={r.id} className="today-place-line">
                            {r.name} · {r.reason}
                            {mapped(r.id) ? ` · ${mapped(r.id)}` : ''}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="today-place-line">Nothing ruled out.</p>
            )}
        </TodayModal>
    );
}
