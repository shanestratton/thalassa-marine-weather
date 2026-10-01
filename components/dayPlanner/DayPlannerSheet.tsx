import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VesselProfile } from '../../types/vessel';
import type { BoatFix } from '../../services/boatPositionChain';
import type { TrialRouteReview } from '../../services/autoroutingReview';
import {
    assessDayPlanRoute,
    type DayPlanOption,
    type DayPlanRequest,
    type DayPlanResult,
} from '../../services/dayPlanner/engine';
import { dayPlannerVesselInputs, runDayPlanner } from '../../services/dayPlanner/runtime';
import { saveDayPlanWithCatalogueCheck } from '../../services/dayPlanner/save';
import type { CataloguePlanSelection } from '../../services/dayPlanner/cataloguePlanningTypes';
import {
    dayPlanDuration,
    dayPlanInputTime,
    dayPlanTime as formatDayPlanTime,
    dayPlanTimeZoneLabel,
    nextLocalMorning,
    parseDayPlanInput,
} from '../../services/dayPlanner/presentation';
import type { DayPlannerActivity } from '../../services/dayPlanner/destinations';
import { resolvePlanningArea } from '../../services/dayPlanner/regions';
import {
    CONDITIONS_MAX_AGE_MS,
    CONDITION_COLOURS,
    CONDITION_LABELS,
    type TrafficLight,
} from '../../services/anchorages/placeConditions';
import {
    plannerVesselLabel,
    PLANNER_LIVE_FIX_MS,
    readPlannerVesselPosition,
} from '../../services/plannerVesselPosition';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { snapshotAutoroutingVesselProfile } from '../../services/autoroutingVesselProfile';
import { evaluateAutoroutingProposalSave } from '../../services/autoroutingProposalSave';
import { getRegistryFingerprint, subscribe as subscribeCharts } from '../../services/enc/EncCellMetadata';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { lazyRetry } from '../../utils/lazyRetry';
import { DayPlanOutline } from './DayPlanOutline';
import { CatalogueTripPicker } from './CatalogueTripPicker';
import './DayPlanner.css';

const ChartReview = lazyRetry(() =>
    import('../autorouting/AutoroutingTrialWorkspace').then((m) => ({ default: m.AutoroutingTrialWorkspace })),
);
const ACTIVITY_LABELS: [DayPlannerActivity, string][] = [
    ['snorkel', 'Snorkel'],
    ['beach', 'Beach'],
    ['walk', 'Walk'],
    ['lunch', 'Picnic lunch'],
    ['quiet', 'Quiet stop'],
    ['explore', 'Explore mapped stops'],
];
const HOUR = 3_600_000;
const lightLabel = (light: TrafficLight) =>
    light === 'green'
        ? 'Favourable forecast'
        : light === 'amber'
          ? 'Review cautions'
          : light === 'red'
            ? 'Adverse / restricted'
            : 'Checks incomplete';
const Badge = ({ light, children }: { light: TrafficLight; children: React.ReactNode }) => (
    <span className="day-plan-badge" data-condition={light} style={{ color: CONDITION_COLOURS[light] }}>
        <span aria-hidden="true">● </span>
        {children}
    </span>
);

function routeDisplay(leg: DayPlanOption['legs'][number], draftM: number): { light: TrafficLight; label: string } {
    if (leg.review.phase !== 'complete') return { light: 'unknown', label: 'Chart checks incomplete' };
    try {
        const check = assessDayPlanRoute(leg.route, leg.review, draftM);
        return {
            light: check.light,
            label: check.light === 'unknown' ? 'Chart coverage incomplete' : 'Review chart cautions',
        };
    } catch (cause) {
        return { light: 'red', label: cause instanceof Error ? cause.message : 'Chart review needs attention' };
    }
}

function optionExpired(option: DayPlanOption, calculatedAt: number, now: number): boolean {
    return (
        option.departureMs <= now ||
        [calculatedAt, option.conditions.fetchedAt, option.transit.fetchedAt].some(
            (stamp) =>
                stamp !== undefined &&
                (!Number.isFinite(stamp) || now - stamp > CONDITIONS_MAX_AGE_MS || stamp > now + 60_000),
        )
    );
}

export default function DayPlannerSheet({
    vessel,
    mapboxToken,
    onClose,
    onOpenSaved,
}: {
    vessel: VesselProfile | null;
    mapboxToken: string;
    onClose: () => void;
    onOpenSaved: (id: string) => void;
}) {
    const [scope] = useState(getAuthIdentityScope);
    const titleId = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    const [reviewLeg, setReviewLeg] = useState<number | null>(null);
    const dialogRef = useFocusTrap(reviewLeg === null, { initialFocusRef: closeRef, onEscape: onClose });
    const [fix, setFix] = useState<BoatFix | null>(null);
    const [locating, setLocating] = useState(false);
    const [positionMessage, setPositionMessage] = useState('');
    const [manualPosition, setManualPosition] = useState(false);
    const [lat, setLat] = useState('');
    const [lon, setLon] = useState('');
    const [startLabel, setStartLabel] = useState('Yacht position');
    const [confirmedPosition, setConfirmedPosition] = useState(false);
    const [initialDeparture] = useState(() => Math.ceil((Date.now() + 30 * 60_000) / (15 * 60_000)) * 15 * 60_000);
    const [timeZone, setTimeZone] = useState('Australia/Brisbane');
    const [departure, setDeparture] = useState(() => dayPlanInputTime(initialDeparture));
    const [overnightUntil, setOvernightUntil] = useState(() => dayPlanInputTime(nextLocalMorning(initialDeparture)));
    const [overnightEndEdited, setOvernightEndEdited] = useState(false);
    const [returnBy, setReturnBy] = useState('');
    const [mode, setMode] = useState<'return' | 'overnight'>('return');
    const [maxSailing, setMaxSailing] = useState('3');
    const [stopHours, setStopHours] = useState('2');
    const [activities, setActivities] = useState<DayPlannerActivity[]>([]);
    const [destinationId, setDestinationId] = useState('');
    const [catalogueSelection, setCatalogueSelection] = useState<CataloguePlanSelection | null>(null);
    const [catalogueReadyKey, setCatalogueReadyKey] = useState('');
    const [flexibleStart, setFlexibleStart] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [result, setResult] = useState<DayPlanResult | null>(null);
    const [request, setRequest] = useState<DayPlanRequest | null>(null);
    const [selected, setSelected] = useState<DayPlanOption | null>(null);
    const [reviewedLegs, setReviewedLegs] = useState<number[]>([]);
    const [acknowledged, setAcknowledged] = useState(false);
    const [savedIds, setSavedIds] = useState<string[]>([]);
    const [saveMessage, setSaveMessage] = useState('');
    const [now, setNow] = useState(Date.now);
    const active = useRef<AbortController | null>(null);
    const activeSave = useRef<AbortController | null>(null);
    const [saveBusy, setSaveBusy] = useState(false);
    const vesselRef = useRef(vessel);
    vesselRef.current = vessel;
    const saving = useRef(false);
    const mounted = useRef(true);
    const locationRun = useRef(0);
    const scopeValid = () => mounted.current && isAuthIdentityScopeCurrent(scope);
    const startValid =
        lat.trim() !== '' &&
        lon.trim() !== '' &&
        Number.isFinite(+lat) &&
        Number.isFinite(+lon) &&
        Math.abs(+lat) <= 80 &&
        Math.abs(+lon) <= 180;
    const areaResolution = useMemo(() => {
        if (!startValid) return { area: null, error: '' };
        try {
            return { area: resolvePlanningArea({ lat: +lat, lon: +lon }), error: '' };
        } catch {
            return {
                area: null,
                error: 'Could not resolve coverage or local time for this departure. Check the coordinates.',
            };
        }
    }, [lat, lon, startValid]);
    const area = areaResolution.area;
    const coverage = area?.coverage;
    const mappedMode = area?.coverage === 'mapped-reference';
    const activityChoices = ACTIVITY_LABELS.filter(([activity]) =>
        mappedMode ? activity === 'explore' : activity !== 'explore',
    );
    const localDestinations = coverage === 'reviewed' ? area?.region?.destinations : undefined;
    const chosenDestination = localDestinations?.find((destination) => destination.id === destinationId);
    const catalogueContextKey = `${lat},${lon}/${mode}/${JSON.stringify(catalogueSelection)}`;
    const catalogueReady = !catalogueSelection || catalogueReadyKey === catalogueContextKey;
    const changePlan = useCallback(() => {
        active.current?.abort();
        active.current = null;
        activeSave.current?.abort();
        activeSave.current = null;
        setSaveBusy(false);
        setBusy(false);
        setError('');
        setResult(null);
        setRequest(null);
        setSelected(null);
        setReviewLeg(null);
        setReviewedLegs([]);
        setAcknowledged(false);
        setSavedIds([]);
        setSaveMessage('');
        saving.current = false;
    }, []);
    const chooseCatalogue = useCallback(
        (selection: CataloguePlanSelection | null) => {
            changePlan();
            setCatalogueReadyKey('');
            setCatalogueSelection(selection);
            if (selection) setDestinationId('');
        },
        [changePlan],
    );
    const catalogueReadiness = useCallback(
        (ready: boolean) => {
            setCatalogueReadyKey(ready ? catalogueContextKey : '');
        },
        [catalogueContextKey],
    );

    useEffect(() => {
        const nextZone = area?.timeZone;
        if (!nextZone || nextZone === timeZone) return;
        // Preserve the chosen instant when the yacht position resolves overseas.
        // Never silently reinterpret an Australian wall-clock value in another zone.
        const moveClock = (value: string) => {
            const instant = parseDayPlanInput(value, timeZone);
            return Number.isFinite(instant) ? dayPlanInputTime(instant, nextZone) : '';
        };
        setDeparture(moveClock);
        setReturnBy(moveClock);
        if (overnightEndEdited) setOvernightUntil(moveClock);
        else {
            const instant = parseDayPlanInput(departure, timeZone);
            setOvernightUntil(
                Number.isFinite(instant) ? dayPlanInputTime(nextLocalMorning(instant, nextZone), nextZone) : '',
            );
        }
        setTimeZone(nextZone);
    }, [area?.timeZone, timeZone, overnightEndEdited, departure]);

    useEffect(() => {
        setDestinationId('');
        setActivities(mappedMode ? ['explore'] : []);
        changePlan();
    }, [area?.id, coverage, mappedMode, changePlan]);

    // A single explicitly labelled departure-zone clock across the on-screen
    // itinerary avoids quietly mixing time zones on short border crossings.
    const displayZone = request?.timeZone ?? timeZone;
    const dayPlanTime = (instant: number) => formatDayPlanTime(instant, displayZone);
    const departureInstant = useMemo(() => parseDayPlanInput(departure, timeZone), [departure, timeZone]);
    const vesselProfile = snapshotAutoroutingVesselProfile(vessel);
    let inputs: ReturnType<typeof dayPlannerVesselInputs> | null = null;
    let profileError = '';
    try {
        if (vessel) inputs = dayPlannerVesselInputs(vessel);
        else profileError = 'Set your vessel draft and cruising speed in Vessel first.';
    } catch (cause) {
        profileError = cause instanceof Error ? cause.message : 'Check your vessel profile.';
    }

    const locate = useCallback(async () => {
        const id = ++locationRun.current;
        setLocating(true);
        setPositionMessage('');
        try {
            const next = await readPlannerVesselPosition();
            if (!mounted.current || id !== locationRun.current || !isAuthIdentityScopeCurrent(scope)) return;
            changePlan();
            setFix(next);
            setConfirmedPosition(false);
            if (next) {
                setLat(String(next.latitude));
                setLon(String(next.longitude));
                setManualPosition(false);
                setStartLabel('Yacht position');
            } else
                setPositionMessage(
                    'No yacht position available. Enter a departure position below; this device’s location is not substituted.',
                );
        } catch {
            if (mounted.current && id === locationRun.current && isAuthIdentityScopeCurrent(scope))
                setPositionMessage('Could not read the yacht position. You can enter one below.');
        } finally {
            if (mounted.current && id === locationRun.current) setLocating(false);
        }
    }, [scope, changePlan]);

    useEffect(() => {
        mounted.current = true;
        void locate();
        const cancelIdentity = subscribeAuthIdentityScope(() => {
            active.current?.abort();
            activeSave.current?.abort();
            onClose();
        });
        const clock = window.setInterval(() => setNow(Date.now()), 30_000);
        const chartChange = subscribeCharts(() => {
            setAcknowledged(false);
            setNow(Date.now());
        });
        return () => {
            mounted.current = false;
            // This is a request sequence counter, not a captured DOM ref.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            locationRun.current++;
            active.current?.abort();
            activeSave.current?.abort();
            cancelIdentity();
            chartChange();
            window.clearInterval(clock);
        };
    }, [locate, onClose]);

    const positionNeedsConfirmation = manualPosition || !fix || now - fix.timestamp > PLANNER_LIVE_FIX_MS;
    const calculate = async () => {
        if (!vessel || !inputs || !scopeValid() || busy) return;
        if (!catalogueReady) {
            setError('Complete the shared catalogue selection, or explicitly choose regional or mapped stops.');
            return;
        }
        const needsConfirmationNow = manualPosition || !fix || Date.now() - fix.timestamp > PLANNER_LIVE_FIX_MS;
        if (!startValid || !area || area.timeZone !== timeZone || (needsConfirmationNow && !confirmedPosition)) {
            setNow(Date.now());
            setError('Confirm your departure position first.');
            return;
        }
        const departureMs = parseDayPlanInput(departure, timeZone);
        const overnightUntilMs = parseDayPlanInput(overnightUntil, timeZone);
        const returnByMs = parseDayPlanInput(returnBy, timeZone);
        if (
            !Number.isFinite(departureMs) ||
            (mode === 'overnight' && !Number.isFinite(overnightUntilMs)) ||
            (mode === 'return' && returnBy && !Number.isFinite(returnByMs))
        ) {
            setError(
                'Choose a valid, unambiguous local date and time. Times skipped or repeated when daylight saving changes cannot be used.',
            );
            return;
        }
        const catalogueRequestSelection = catalogueSelection ? { ...catalogueSelection } : null;
        if (mode === 'overnight' && catalogueRequestSelection) delete catalogueRequestSelection.return;
        const nextRequest: DayPlanRequest = {
            start: { lat: +lat, lon: +lon, label: startLabel.trim() || 'Departure' },
            departureMs,
            timeZone,
            maxSailingHours: +maxSailing,
            stopHours: +stopHours,
            mode,
            activities,
            ...(catalogueRequestSelection
                ? { catalogueSelection: catalogueRequestSelection }
                : chosenDestination
                  ? { destinationIds: [chosenDestination.id] }
                  : {}),
            speedKts: inputs.speedKts,
            draftM: inputs.draftM,
            maxWindKts: Math.min(inputs.maxWindKts ?? 20, 20),
            maxGustKts: 25,
            maxWaveM: Math.min(inputs.maxWaveM ?? 1.5, 1.5),
            flexibleStart,
            ...(mode === 'overnight' ? { overnightUntilMs } : {}),
            ...(mode === 'return' && returnBy ? { returnByMs } : {}),
        };
        const controller = new AbortController();
        active.current?.abort();
        active.current = controller;
        setBusy(true);
        setError('');
        setProgress('Checking your boat and nearby stops…');
        setResult(null);
        setSelected(null);
        setReviewedLegs([]);
        setAcknowledged(false);
        setSavedIds([]);
        saving.current = false;
        try {
            const next = await runDayPlanner(nextRequest, vessel, {
                signal: controller.signal,
                mapboxToken,
                onProgress: (p) => {
                    if (active.current === controller && scopeValid() && !controller.signal.aborted)
                        setProgress(
                            `${p.phase === 'routing' ? 'Calculating routes' : p.phase === 'weather' ? 'Reading timed forecasts' : 'Compared'} · ${p.destination} (${p.completed}/${p.total})`,
                        );
                },
            });
            if (active.current !== controller || !scopeValid() || controller.signal.aborted) return;
            setRequest(nextRequest);
            setResult(next);
            setNow(Date.now());
        } catch (cause) {
            if (active.current === controller && scopeValid() && !controller.signal.aborted)
                setError(cause instanceof Error ? cause.message : 'Could not build the day plan. Please try again.');
        } finally {
            if (active.current === controller && scopeValid()) {
                active.current = null;
                setBusy(false);
            }
        }
    };
    const acceptReview = useCallback(
        (review: TrialRouteReview | null) => {
            if (reviewLeg === null) return;
            setSelected((value) =>
                value
                    ? {
                          ...value,
                          legs: value.legs.map((leg, i) =>
                              i === reviewLeg
                                  ? {
                                        ...leg,
                                        review: review ?? { phase: 'checking', legs: leg.review.legs.map(() => null) },
                                    }
                                  : leg,
                          ),
                      }
                    : null,
            );
            setAcknowledged(false);
            if (review?.phase === 'complete') setReviewedLegs((ids) => [...new Set([...ids, reviewLeg])]);
        },
        [reviewLeg],
    );
    const closeReview = useCallback(() => setReviewLeg(null), []);
    const stale =
        !!result &&
        (selected
            ? optionExpired(selected, result.calculatedAt, now)
            : result.options.length > 0 &&
              result.options.every((option) => optionExpired(option, result.calculatedAt, now)));
    const saveBlock = !selected
        ? ''
        : selected.legs
              .map((leg) =>
                  evaluateAutoroutingProposalSave(
                      leg.route,
                      leg.review,
                      request?.draftM ?? NaN,
                      vesselProfile.draftStatus !== 'measured',
                  ),
              )
              .find((eligibility) => !eligibility.eligible)?.reason;
    // Read the registry on render as well as at save; never retain an old consent after a chart change.
    const chartsMatch = selected?.legs.every(
        (leg) => leg.review.basis?.registryFingerprint === getRegistryFingerprint(),
    );
    const canSave =
        !!selected &&
        !!request &&
        !stale &&
        !saveBlock &&
        chartsMatch &&
        selected.legs.every(
            (leg, i) => reviewedLegs.includes(i) && routeDisplay(leg, request.draftM).light !== 'red',
        ) &&
        acknowledged &&
        !saveBusy &&
        !savedIds.length;
    const save = async () => {
        if (!canSave || saving.current || !selected || !request || !result || !inputs || !scopeValid()) return;
        saving.current = true;
        const controller = new AbortController();
        activeSave.current?.abort();
        activeSave.current = controller;
        const saveCurrent = () => activeSave.current === controller && !controller.signal.aborted && scopeValid();
        setSaveBusy(true);
        setError('');
        try {
            const saved = await saveDayPlanWithCatalogueCheck(
                {
                    option: selected,
                    request: { ...request, departureMs: selected.departureMs },
                    acknowledgedPlannedOnly: acknowledged,
                    calculatedAt: result.calculatedAt,
                    currentVesselProfile: vesselProfile,
                    currentVesselInputs: inputs,
                },
                scope,
                {
                    signal: controller.signal,
                    getCurrentVesselProfile: () => snapshotAutoroutingVesselProfile(vesselRef.current),
                    getCurrentVesselInputs: () => {
                        if (!vesselRef.current) throw new Error('Your vessel changed. Recalculate before saving.');
                        return dayPlannerVesselInputs(vesselRef.current);
                    },
                },
            );
            if (!saveCurrent()) return;
            setSavedIds(saved.traces.map((trace) => trace.id));
            setSaveMessage('Saved on this device. Private sync pending. Nothing is being followed or recorded.');
            void saved.cloud
                .then((statuses) => {
                    if (!saveCurrent()) return;
                    setSaveMessage(
                        statuses.every((status) => status === 'ok')
                            ? 'Saved to your private route library. Nothing is being followed or recorded.'
                            : 'Saved on this device. Some private sync is pending; keep this device’s copy.',
                    );
                })
                .catch(() => {
                    if (saveCurrent()) setSaveMessage('Saved on this device; private sync is pending.');
                });
        } catch (cause) {
            if (!saveCurrent()) return;
            saving.current = false;
            setError(cause instanceof Error ? cause.message : 'Could not save the itinerary.');
        } finally {
            if (saveCurrent()) setSaveBusy(false);
        }
    };

    if (reviewLeg !== null && selected && request)
        return (
            <Suspense
                fallback={
                    <OverlayPortal className="day-plan-overlay">
                        <p role="status">Opening ENC review…</p>
                    </OverlayPortal>
                }
            >
                <ChartReview
                    key={`${selected.id}:${reviewLeg}`}
                    reviewProposal={selected.legs[reviewLeg].route}
                    onReviewChange={acceptReview}
                    onClose={closeReview}
                    mapboxToken={mapboxToken}
                    initialDraftM={request.draftM}
                    initialSpeedKts={request.speedKts}
                    initialVesselProfile={vesselProfile}
                />
            </Suspense>
        );

    return (
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="day-plan-overlay"
        >
            <section className="day-plan-sheet">
                <header className="day-plan-header">
                    <div>
                        <p className="day-plan-eyebrow">{area?.name ?? 'Day trips & overnight stops'}</p>
                        <h2 id={titleId}>Plan Your Day</h2>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        className="day-plan-close"
                        aria-label="Close day planner"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>
                <div className="day-plan-body">
                    {!result && (
                        <>
                            <p className="day-plan-intro">A stop worth sailing to.</p>
                            <fieldset className="day-plan-section" disabled={busy} onChange={changePlan}>
                                <legend>Departure</legend>
                                <p className="day-plan-muted">
                                    {manualPosition
                                        ? 'Manually chosen departure'
                                        : fix
                                          ? plannerVesselLabel(fix, now)
                                          : locating
                                            ? 'Finding the yacht…'
                                            : 'Departure position needed'}
                                </p>
                                {positionMessage && <p className="day-plan-notice">{positionMessage}</p>}
                                <button
                                    type="button"
                                    className="day-plan-secondary"
                                    disabled={locating}
                                    onClick={() => {
                                        changePlan();
                                        void locate();
                                    }}
                                >
                                    {locating ? 'Locating…' : 'Use yacht position'}
                                </button>
                                <details open={!fix || manualPosition} className="day-plan-details">
                                    <summary>Position details</summary>
                                    {fix && !manualPosition && (
                                        <p className="day-plan-fine">
                                            Source:{' '}
                                            {fix.rung === 'cloud'
                                                ? 'Vessel cloud report'
                                                : fix.rung === 'bus'
                                                  ? 'Vessel instruments'
                                                  : 'Vessel Pi'}{' '}
                                            · {fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)}
                                        </p>
                                    )}
                                    <label>
                                        Departure name
                                        <input
                                            value={startLabel}
                                            maxLength={80}
                                            onChange={(e) => setStartLabel(e.target.value)}
                                        />
                                    </label>
                                    <div className="day-plan-two">
                                        <label>
                                            Latitude
                                            <input
                                                type="number"
                                                step="any"
                                                inputMode="decimal"
                                                value={lat}
                                                onChange={(e) => {
                                                    locationRun.current++;
                                                    setLocating(false);
                                                    setLat(e.target.value);
                                                    setManualPosition(true);
                                                    setConfirmedPosition(false);
                                                }}
                                            />
                                        </label>
                                        <label>
                                            Longitude
                                            <input
                                                type="number"
                                                step="any"
                                                inputMode="decimal"
                                                value={lon}
                                                onChange={(e) => {
                                                    locationRun.current++;
                                                    setLocating(false);
                                                    setLon(e.target.value);
                                                    setManualPosition(true);
                                                    setConfirmedPosition(false);
                                                }}
                                            />
                                        </label>
                                    </div>
                                </details>
                                {positionNeedsConfirmation && startValid && (
                                    <label className="day-plan-check">
                                        <input
                                            type="checkbox"
                                            checked={confirmedPosition}
                                            onChange={(e) => setConfirmedPosition(e.target.checked)}
                                        />
                                        Use this position as my departure.
                                    </label>
                                )}
                            </fieldset>
                            <fieldset className="day-plan-section" disabled={busy} onChange={changePlan}>
                                <legend>Your stop</legend>
                                {localDestinations && (
                                    <label>
                                        Destination
                                        <select
                                            value={chosenDestination?.id ?? ''}
                                            onChange={(e) => {
                                                setDestinationId(e.target.value);
                                                setCatalogueSelection(null);
                                                setCatalogueReadyKey('');
                                            }}
                                        >
                                            <option value="">All local destinations</option>
                                            {localDestinations.map((destination) => (
                                                <option key={destination.id} value={destination.id}>
                                                    {destination.name}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                                <CatalogueTripPicker
                                    position={{ lat: +lat, lon: +lon }}
                                    enabled={
                                        !!scope.userId &&
                                        startValid &&
                                        !!area &&
                                        (!positionNeedsConfirmation || confirmedPosition)
                                    }
                                    mode={mode}
                                    value={catalogueSelection}
                                    onChange={chooseCatalogue}
                                    onReadyChange={catalogueReadiness}
                                />
                                {area && (
                                    <aside
                                        className="day-plan-coverage day-plan-coverage-compact"
                                        aria-label="Destination coverage"
                                    >
                                        <strong>
                                            {catalogueSelection
                                                ? 'Shared catalogue choice · access unverified'
                                                : mappedMode
                                                  ? 'Mapped stops · local details unverified'
                                                  : `${area.name} · reviewed destination guide`}
                                        </strong>
                                        {mappedMode && <p>Access and shelter unverified. Checks remain incomplete.</p>}
                                    </aside>
                                )}
                                <p className="day-plan-field-label">
                                    Activities <span>optional</span>
                                </p>
                                <div className="day-plan-chips">
                                    {!mappedMode && (
                                        <button
                                            type="button"
                                            aria-pressed={!activities.length}
                                            onClick={() => {
                                                changePlan();
                                                setActivities([]);
                                            }}
                                        >
                                            No preference
                                        </button>
                                    )}
                                    {activityChoices.map(([id, label]) => (
                                        <button
                                            type="button"
                                            key={id}
                                            aria-pressed={activities.includes(id)}
                                            onClick={() => {
                                                changePlan();
                                                setActivities((value) =>
                                                    value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
                                                );
                                            }}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <p className="day-plan-fine">
                                    {catalogueSelection
                                        ? 'Your shared catalogue choice is checked even if activities do not match.'
                                        : chosenDestination
                                          ? 'Your chosen destination is checked even if activities do not match.'
                                          : mappedMode
                                            ? 'Map references only; activities and landing access are unverified.'
                                            : activities.length
                                              ? 'Suggestions match at least one activity.'
                                              : 'Compare nearby stops, with no activity filter.'}
                                </p>
                            </fieldset>
                            <fieldset className="day-plan-section" disabled={busy} onChange={changePlan}>
                                <legend>Your time</legend>
                                <div className="day-plan-chips day-plan-mode">
                                    {(['return', 'overnight'] as const).map((value) => (
                                        <button
                                            type="button"
                                            key={value}
                                            aria-pressed={mode === value}
                                            onClick={() => {
                                                changePlan();
                                                setMode(value);
                                            }}
                                        >
                                            {value === 'return' ? 'Return trip' : 'Stay overnight'}
                                        </button>
                                    ))}
                                </div>
                                <p className="day-plan-fine">
                                    {area
                                        ? `Departure-area time: ${dayPlanTimeZoneLabel(Number.isFinite(departureInstant) ? departureInstant : now, timeZone)}`
                                        : 'Choose a departure to set the local planning clock.'}
                                </p>
                                <label>
                                    Leave at
                                    <input
                                        type="datetime-local"
                                        value={departure}
                                        min={dayPlanInputTime(now, timeZone)}
                                        max={dayPlanInputTime(now + 5 * 24 * HOUR, timeZone)}
                                        onChange={(e) => {
                                            const value = e.target.value;
                                            setDeparture(value);
                                            const next = parseDayPlanInput(value, timeZone);
                                            if (!overnightEndEdited && Number.isFinite(next))
                                                setOvernightUntil(
                                                    dayPlanInputTime(nextLocalMorning(next, timeZone), timeZone),
                                                );
                                        }}
                                    />
                                </label>
                                <div className="day-plan-two">
                                    <label>
                                        Sailing limit (hrs)
                                        <input
                                            type="number"
                                            min="0.5"
                                            max="12"
                                            step="0.5"
                                            aria-describedby={`${titleId}-sailing-help`}
                                            value={maxSailing}
                                            onChange={(e) => setMaxSailing(e.target.value)}
                                        />
                                    </label>
                                    <label>
                                        Stop time (hrs)
                                        <input
                                            type="number"
                                            min="0.5"
                                            max="12"
                                            step="0.5"
                                            value={stopHours}
                                            onChange={(e) => setStopHours(e.target.value)}
                                        />
                                    </label>
                                </div>
                                <p className="day-plan-fine" id={`${titleId}-sailing-help`}>
                                    {mode === 'return'
                                        ? 'Sailing limit covers both legs. Stop time is extra.'
                                        : 'Sailing limit covers the outward leg. Stop time is separate.'}
                                </p>
                                {mode === 'return' ? (
                                    <label>
                                        Back by (optional)
                                        <input
                                            type="datetime-local"
                                            value={returnBy}
                                            min={departure}
                                            onChange={(e) => setReturnBy(e.target.value)}
                                        />
                                    </label>
                                ) : (
                                    <label>
                                        Stay until
                                        <input
                                            type="datetime-local"
                                            value={overnightUntil}
                                            min={departure}
                                            onChange={(e) => {
                                                setOvernightEndEdited(true);
                                                setOvernightUntil(e.target.value);
                                            }}
                                        />
                                    </label>
                                )}
                                <label className="day-plan-check">
                                    <input
                                        type="checkbox"
                                        checked={flexibleStart}
                                        onChange={(e) => setFlexibleStart(e.target.checked)}
                                    />
                                    Compare leaving 1 or 2 hours later
                                </label>
                                {inputs && (
                                    <p className="day-plan-muted">
                                        {vessel?.name || 'Your yacht'} · {inputs.speedKts.toFixed(1)} kn cruising ·{' '}
                                        {inputs.draftM.toFixed(2)} m draft
                                    </p>
                                )}
                            </fieldset>
                            <details className="day-plan-details">
                                <summary>Checks &amp; assumptions</summary>
                                {inputs && (
                                    <p>
                                        Screening limits: {Math.min(inputs.maxWindKts ?? 20, 20)} kn wind · 25 kn gusts
                                        · {Math.min(inputs.maxWaveM ?? 1.5, 1.5).toFixed(1)} m transit waves.
                                    </p>
                                )}
                                <p>
                                    Sailing estimates use profile speed, not tidal currents. Wind and gust limits apply
                                    during the trip and stay; wave limits during transit. Stop time is the minimum
                                    visit; an overnight stay is assessed through your chosen end time.
                                </p>
                                <p>
                                    {catalogueSelection
                                        ? 'Shared catalogue entries retain source reviews and limitations. These do not establish a verified approach or current access, shelter and holding.'
                                        : mappedMode
                                          ? 'Mapped stops have unverified access, shelter, holding and activities. They stay “Checks incomplete” even with a favourable forecast. Coverage varies; some areas have no usable mapped stops.'
                                          : 'Reviewed guides document activities and local notes. Current access and anchoring conditions still need checking. Picnic lunch means bring your own. Quiet stops do not predict crowds or calm water; snorkelling visibility is unverified.'}
                                </p>
                                <p>
                                    Up to four nearby destinations per search. Every qualifying assessed option is
                                    shown.
                                    {localDestinations
                                        ? ' Choose a destination to check one outside this shortlist.'
                                        : ''}{' '}
                                    Calculated routes and chart checks are separate from wind, gust and wave forecasts.
                                    Stops use mapped reference positions, not approved anchoring or landing points.
                                    Check current charts, tides, restrictions, access and holding independently. No
                                    reservations or live mooring availability.
                                </p>
                                <p>
                                    Data: © OpenStreetMap contributors (ODbL). Reviewed regional guides add their own
                                    sources. Forecasts: Open-Meteo / national weather services. Specific sources are
                                    attached to each option.
                                </p>
                            </details>
                        </>
                    )}
                    {result && request && (
                        <aside className="day-plan-coverage" aria-label="Plan coverage and time zone">
                            <strong>
                                {result.coverage?.type === 'catalogue-reference'
                                    ? 'Shared catalogue · reviewed source references'
                                    : result.coverage?.type === 'mapped-reference' ||
                                        request.activities.includes('explore')
                                      ? 'Mapped stops · local details unverified'
                                      : `${result.coverage?.name ?? area?.name ?? 'Regional'} · reviewed destination guide`}
                            </strong>
                            <p>
                                All itinerary times use the departure area:{' '}
                                {dayPlanTimeZoneLabel(request.departureMs, displayZone)}.
                            </p>
                            {result.coverage?.type === 'catalogue-reference' && (
                                <p>
                                    Reviewed source references do not verify the approach, access, shelter or current
                                    conditions. Local conditions remain unassessed.
                                </p>
                            )}
                            {!!result.coverage?.limitations.length && (
                                <ul>
                                    {result.coverage.limitations.map((note) => (
                                        <li key={note}>{note}</li>
                                    ))}
                                </ul>
                            )}
                        </aside>
                    )}
                    {result && request && !selected && (
                        <>
                            <p className="day-plan-intro">
                                {result.options.length
                                    ? 'Calculated routes. Timed forecasts. Your final call.'
                                    : 'No matching plan this time.'}
                            </p>
                            <p className="day-plan-muted">
                                {request.flexibleStart
                                    ? 'Compared your start and up to two later departures.'
                                    : `Leaving ${dayPlanTime(request.departureMs)}`}{' '}
                                · {request.speedKts.toFixed(1)} kn · up to {request.maxSailingHours}h sailing
                            </p>
                            {result.options.map((option, index) => (
                                <article className="day-plan-option" key={option.id}>
                                    <div className="day-plan-option-top">
                                        <span className="day-plan-eyebrow">Option {index + 1}</span>
                                        <Badge
                                            light={
                                                optionExpired(option, result.calculatedAt, now)
                                                    ? 'unknown'
                                                    : option.light
                                            }
                                        >
                                            {optionExpired(option, result.calculatedAt, now)
                                                ? 'Refresh needed'
                                                : lightLabel(option.light)}
                                        </Badge>
                                    </div>
                                    <h3>{option.candidate.destination.name}</h3>
                                    {option.candidate.destination.catalogueQuality === 'mapped-reference' && (
                                        <p className="day-plan-notice">
                                            Mapped anchorage only. Local details unverified; not an approved anchoring
                                            point.
                                        </p>
                                    )}
                                    {option.candidate.destination.catalogueQuality === 'catalogue-reference' && (
                                        <p className="day-plan-notice">
                                            Reviewed catalogue reference. Approach and local conditions remain
                                            unverified.
                                        </p>
                                    )}
                                    <p>{option.candidate.destination.summary}</p>
                                    <p className="day-plan-fine">
                                        {request.catalogueSelection
                                            ? 'Your shared catalogue choice · activities do not filter this stop'
                                            : request.destinationIds?.length
                                              ? 'Your chosen destination · activities do not filter this stop'
                                              : !request.activities.length
                                                ? 'No activity preference'
                                                : `Matches: ${ACTIVITY_LABELS.filter(
                                                      ([activity]) =>
                                                          request.activities.includes(activity) &&
                                                          option.candidate.destination.activities.includes(activity),
                                                  )
                                                      .map(([, label]) => label)
                                                      .join(' · ')}`}
                                    </p>
                                    <DayPlanOutline option={option} />
                                    <div className="day-plan-metrics">
                                        <div>
                                            <strong>
                                                {option.distanceNM.toFixed(1)} <small>NM</small>
                                            </strong>
                                            <span>calculated route</span>
                                        </div>
                                        <div>
                                            <strong>{dayPlanDuration(option.sailingHours)}</strong>
                                            <span>underway estimate</span>
                                        </div>
                                    </div>
                                    <p className="day-plan-muted">
                                        Leave {dayPlanTime(option.departureMs)} · arrive {dayPlanTime(option.arrivalMs)}
                                    </p>
                                    <p className="day-plan-muted">
                                        {request.mode === 'return' ? 'Back' : 'Stay assessed until'}{' '}
                                        {dayPlanTime(option.finishMs)}
                                    </p>
                                    <p className="day-plan-notice">{option.conditions.reasons[0]}</p>
                                    <button
                                        type="button"
                                        className="day-plan-primary"
                                        disabled={optionExpired(option, result.calculatedAt, now)}
                                        onClick={() => {
                                            setSelected(option);
                                            setReviewedLegs([]);
                                            setAcknowledged(false);
                                            setError('');
                                        }}
                                    >
                                        Review in Plan
                                    </button>
                                </article>
                            ))}
                            {!!result.excluded.length && (
                                <details className="day-plan-details" open={!result.options.length}>
                                    <summary>Why other stops weren’t offered ({result.excluded.length})</summary>
                                    <ul>
                                        {result.excluded.map((item, i) => (
                                            <li key={i}>
                                                <strong>{item.name}:</strong> {item.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                            <p className="day-plan-fine">
                                A favourable forecast is not navigation clearance. No option reserves a berth or buoy.
                            </p>
                        </>
                    )}
                    {selected && request && (
                        <>
                            <button
                                type="button"
                                className="day-plan-secondary"
                                disabled={!!savedIds.length || saveBusy}
                                onClick={() => {
                                    setSelected(null);
                                    setAcknowledged(false);
                                    setError('');
                                }}
                            >
                                All options
                            </button>
                            <h3 className="day-plan-destination">{selected.candidate.destination.name}</h3>
                            <DayPlanOutline option={selected} />
                            <div className="day-plan-timeline">
                                <p>
                                    <strong>Leave</strong>
                                    <span>{dayPlanTime(selected.departureMs)}</span>
                                </p>
                                <p>
                                    <strong>Arrive at the stop</strong>
                                    <span>{dayPlanTime(selected.arrivalMs)}</span>
                                </p>
                                <p>
                                    <strong>
                                        {request.mode === 'return' ? 'Leave the stop' : 'Stay assessed until'}
                                    </strong>
                                    <span>{dayPlanTime(selected.stayToMs)}</span>
                                </p>
                                {request.mode === 'return' && (
                                    <p>
                                        <strong>Back at your start</strong>
                                        <span>{dayPlanTime(selected.finishMs)}</span>
                                    </p>
                                )}
                            </div>
                            <section className="day-plan-section">
                                <h4>Your stay</h4>
                                <Badge light={stale ? 'unknown' : selected.conditions.light}>
                                    {stale ? 'Refresh needed' : CONDITION_LABELS[selected.conditions.light]}
                                </Badge>
                                <ul>
                                    {selected.conditions.reasons.map((reason, i) => (
                                        <li key={i}>{reason}</li>
                                    ))}
                                </ul>
                                <p className="day-plan-fine">
                                    {dayPlanTime(selected.stayFromMs)} to {dayPlanTime(selected.stayToMs)} ·{' '}
                                    {selected.conditions.fetchedAt
                                        ? `forecast retrieved ${dayPlanTime(selected.conditions.fetchedAt)}`
                                        : 'forecast unavailable'}
                                </p>
                            </section>
                            <section className="day-plan-section">
                                <h4>Underway conditions</h4>
                                <Badge light={stale ? 'unknown' : selected.transit.light}>
                                    {stale ? 'Refresh needed' : CONDITION_LABELS[selected.transit.light]}
                                </Badge>
                                <ul>
                                    {selected.transit.reasons.map((reason, i) => (
                                        <li key={i}>{reason}</li>
                                    ))}
                                </ul>
                            </section>
                            <section className="day-plan-section">
                                <h4>Review every route leg</h4>
                                <p className="day-plan-muted">
                                    Weather colours do not clear a route. Open each leg on the ENC chart.
                                </p>
                                {selected.legs.map((leg, i) => (
                                    <div className="day-plan-leg" key={i}>
                                        <p>
                                            <strong>
                                                {i + 1}.{' '}
                                                {i
                                                    ? `Back to ${request.start.label}`
                                                    : `To ${selected.candidate.destination.name}`}
                                            </strong>
                                            <br />
                                            {leg.distanceNM.toFixed(1)} NM · {dayPlanTime(leg.departureMs)}–
                                            {dayPlanTime(leg.arrivalMs)}
                                        </p>
                                        <Badge light={routeDisplay(leg, request.draftM).light}>
                                            {routeDisplay(leg, request.draftM).label}
                                        </Badge>
                                        <button
                                            type="button"
                                            className="day-plan-secondary"
                                            disabled={!!savedIds.length || saveBusy}
                                            onClick={() => setReviewLeg(i)}
                                        >
                                            {reviewedLegs.includes(i) ? 'Review chart again' : 'Open ENC review'}
                                        </button>
                                    </div>
                                ))}
                            </section>
                            <section className="day-plan-section">
                                <h4>Before going ashore</h4>
                                <ul>
                                    {[
                                        ...selected.candidate.destination.accessNotes,
                                        ...selected.candidate.destination.uncertaintyNotes,
                                    ].map((note, i) => (
                                        <li key={i}>{note}</li>
                                    ))}
                                </ul>
                            </section>
                            <details className="day-plan-details">
                                <summary>Sources, assumptions &amp; all advisories</summary>
                                <a href={selected.candidate.destination.sourceUrl} target="_blank" rel="noreferrer">
                                    {selected.candidate.destination.sourceLabel}
                                </a>
                                <p>
                                    {selected.candidate.destination.catalogueQuality === 'catalogue-reference'
                                        ? 'Reviewed catalogue source reference. This review does not establish an approved approach or current conditions.'
                                        : selected.candidate.destination.catalogueQuality === 'mapped-reference'
                                          ? `Unreviewed map reference${selected.candidate.destination.retrievedAt ? `, retrieved ${selected.candidate.destination.retrievedAt}` : ''}. Retrieval is not verification. Check local notices, access and restrictions.`
                                          : `Destination reference reviewed ${selected.candidate.destination.verifiedAt}. Check current notices before visiting.`}
                                </p>
                                {selected.candidate.destination.supportingSources?.map((source) => (
                                    <p key={source.url}>
                                        <a href={source.url} target="_blank" rel="noreferrer">
                                            {source.label}
                                        </a>
                                    </p>
                                ))}
                                <ul>
                                    {selected.warnings.map((warning, i) => (
                                        <li key={i}>{warning}</li>
                                    ))}
                                </ul>
                                <p>
                                    {selected.candidate.destination.catalogueQuality === 'catalogue-reference'
                                        ? 'Catalogue evidence and limitations are listed above. Source review is separate from navigation checks.'
                                        : 'OpenStreetMap contributors (ODbL). Regional source references are listed above.'}
                                    Forecast: Open-Meteo / national weather services. Routing: Thalassa, on this phone
                                    from your installed charts. Model output is not a guarantee of conditions or
                                    clearance.
                                </p>
                            </details>
                            {!savedIds.length && (
                                <label className="day-plan-check day-plan-ack">
                                    <input
                                        type="checkbox"
                                        checked={acknowledged}
                                        disabled={saveBusy}
                                        onChange={(e) => setAcknowledged(e.target.checked)}
                                    />
                                    I have reviewed each leg and the limitations. Save a private plan only—not
                                    clearance, activation or recording.
                                </label>
                            )}
                            {!savedIds.length && saveBlock && <p className="day-plan-notice">{saveBlock}</p>}
                            {!!savedIds.length && (
                                <p className="day-plan-success" role="status">
                                    {saveMessage}
                                </p>
                            )}
                        </>
                    )}
                    {stale && (
                        <p className="day-plan-notice" role="status">
                            Departure has passed or this report needs refreshing. Change the plan and calculate again.
                        </p>
                    )}
                    {profileError && <p className="day-plan-notice">{profileError}</p>}
                    {areaResolution.error && (
                        <p className="day-plan-error" role="alert">
                            {areaResolution.error}
                        </p>
                    )}
                    {!scope.userId && (
                        <p className="day-plan-notice">Sign in to calculate routes and save a private day plan.</p>
                    )}
                    {error && (
                        <p className="day-plan-error" role="alert">
                            {error}
                        </p>
                    )}
                    {busy && (
                        <p className="day-plan-progress" role="status">
                            {progress}
                        </p>
                    )}
                    {saveBusy && (
                        <p className="day-plan-progress" role="status">
                            Rechecking this plan before saving…
                        </p>
                    )}
                </div>
                <footer className="day-plan-footer">
                    {busy ? (
                        <button
                            type="button"
                            className="day-plan-secondary"
                            onClick={() => {
                                active.current?.abort();
                                active.current = null;
                                setBusy(false);
                                setProgress('');
                            }}
                        >
                            Cancel calculation
                        </button>
                    ) : savedIds.length ? (
                        <button type="button" className="day-plan-primary" onClick={() => onOpenSaved(savedIds[0])}>
                            Open saved plan
                        </button>
                    ) : selected ? (
                        <>
                            <button type="button" className="day-plan-secondary" onClick={changePlan}>
                                Change plan
                            </button>
                            <button
                                type="button"
                                className="day-plan-primary"
                                disabled={!canSave}
                                onClick={() => void save()}
                            >
                                Save {selected.legs.length === 2 ? 'both legs' : 'day plan'}
                            </button>
                        </>
                    ) : result ? (
                        <button type="button" className="day-plan-primary" onClick={changePlan}>
                            Change plan
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="day-plan-primary"
                            disabled={
                                !!profileError ||
                                !scope.userId ||
                                !catalogueReady ||
                                !startValid ||
                                !area ||
                                area.timeZone !== timeZone ||
                                (positionNeedsConfirmation && !confirmedPosition)
                            }
                            onClick={() => void calculate()}
                        >
                            Find my day
                        </button>
                    )}
                </footer>
            </section>
        </OverlayPortal>
    );
}
