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
 *     there and home times from her polar in the forecast wind;
 *   - All places, every one with a plain reason when it is not today.
 *
 * A stop's detail says how each time was worked out; "Plot on chart" sets
 * the Plan page's departure and opens the Manual plotter with straight pins
 * (both ⚡ buttons are parked). The planner never routes, never saves, never
 * expires and never blocks: cautions, not blocks.
 *
 * Everything it shows is worked out by services/dayPlanner/today.ts (pure)
 * from what services/dayPlanner/todayLoader.ts fetched; times are the
 * PLACE's own clock. `io` swaps the sources for fixtures and tests only.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VesselProfile } from '../../types/vessel';
import type { PlotDayAction } from '../../services/deepLink';
import type { BoatFix } from '../../services/boatPositionChain';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { plannerFixAge, readPlannerVesselPosition } from '../../services/plannerVesselPosition';
import { readPlanDeparture, setPlanDeparture } from '../../services/planDeparture';
import { DEFAULT_CRUISING_POLAR } from '../../services/defaultPolar';
import { closeHauledDegFor } from '../../services/sailing/pointOfSail';
import { vesselCruisingSpeedKts } from '../../services/units';
import type { PassageSpeedModel } from '../../services/passagePlan';
import { AGREEMENT_GLYPH } from '../../services/weather/dayAgreement';
import { openExternalUrl } from '../../services/externalLinks';
import { usePassageSpeedPref } from '../../stores/passageHudStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindStore } from '../../stores/WindStore';
import { officialWarningsSource } from '../../utils/officialWarningsSource';
import { DEFAULT_VESSEL } from '../../utils/defaultVessel';
import { PASSAGE_MODEL_CHOICES, passageModelChoice } from '../passage/PassageModelModal';
import { formatLatLon, type LatLon } from '../../services/dayPlanner/places';
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
import { TodayStopDetail, type LandingLoader } from './TodayStopDetail';
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
}

export interface TodaySheetProps {
    /** Always resolved: her profile, or the default boat. */
    vessel: VesselProfile;
    usingDefaultVessel: boolean;
    onClose: () => void;
    onPlot: (action: PlotDayAction) => void;
    /** Settings → Vessel, for the default-boat notice. */
    onOpenVessel?: () => void;
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

export default function TodaySheet({ vessel, usingDefaultVessel, onClose, onPlot, onOpenVessel, io }: TodaySheetProps) {
    const [scope] = useState(getAuthIdentityScope);
    // The sources, fixed for the sheet's life.
    const [sources] = useState(() => ({
        loader: io?.loader,
        now: io?.loader?.now ?? (() => Date.now()),
        readBoat: io?.readBoat ?? readPlannerVesselPosition,
        picker: { readPhone: io?.readPhone, geocode: io?.geocode } as PlacePickerIO,
    }));
    const [boat, setBoat] = useState<BoatFix | null | 'reading'>('reading');
    const [start, setStart] = useState<PlanStart | null>(null);
    const [base, setBase] = useState<TodayBase | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [legs, setLegs] = useState<ReadonlyMap<string, StopLegs>>(() => new Map());
    const [date, setDate] = useState<string | null>(null);
    const [stay, setStay] = useState<StayOption>(DEFAULT_STAY);
    const [screen, setScreen] = useState<Screen>(null);
    const [pickerFocus, setPickerFocus] = useState<'list' | 'type'>('list');
    const [plannedDepartureMs] = useState(() => readPlanDeparture(scope, sources.now()));
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
    const speed = useMemo<PassageSpeedModel>(
        () => ({
            mode: speedPref,
            cruiseKts: vesselCruisingSpeedKts(boatProfile, 6),
            isSail: boatProfile.type === 'sail',
            // The skipper's own table when she has chosen one; never the
            // learned polar (async, and its unfilled cells are zeros).
            polar: settings.polarData ?? DEFAULT_CRUISING_POLAR,
            closeHauledDeg: closeHauledDegFor(boatProfile),
        }),
        [speedPref, boatProfile, settings.polarData],
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

    // ── Close on an account change; read the boat once ──
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
        };
    }, [start, sources]);

    const boatFixAgeMs = start?.kind === 'boat' ? sources.now() - start.fix.timestamp : null;
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
                          plannedDepartureMs,
                          legs,
                          boatFixAgeMs,
                      }),
                  )
                : null,
        [base, stay, limits, speed, usingDefaultVessel, date, plannedDepartureMs, legs, boatFixAgeMs],
    );

    // ── Route forecasts for the stops the engine names (each once per place) ──
    const needKey = view?.needsLegs.map((n) => n.id).join('|') ?? '';
    useEffect(() => {
        if (!view || !legsAbort.current) return;
        const missing = view.needsLegs.filter((n) => !requested.current.has(n.id));
        if (!missing.length) return;
        for (const n of missing) requested.current.add(n.id);
        loadStopLegs(missing, wind, {
            signal: legsAbort.current.signal,
            deps: sources.loader,
            onLegs: (id, stopLegs) => setLegs((prev) => new Map(prev).set(id, stopLegs)),
        }).catch(() => {
            /* cancelled: the sheet closed or the place changed */
        });
        // needKey stands for view.needsLegs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needKey, wind, sources]);

    const chooseStart = useCallback((next: PlanStart) => {
        setScreen(null);
        setStart(next);
    }, []);

    const openPicker = (focus: 'list' | 'type' = 'list') => {
        setPickerFocus(focus);
        setScreen('picker');
    };

    const plot = (row: StopRow, departureMs: number | null) => {
        if (!base) return;
        if (departureMs !== null) setPlanDeparture(departureMs, scope);
        onPlot(plotDayAction(base.start, row.candidate, stay));
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

    const detailRow =
        screen && typeof screen === 'object' && view ? (view.top.find((r) => r.id === screen.stop) ?? null) : null;
    const allCount = view ? view.fits.length + view.notToday.length : 0;
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
                onClose={onClose}
                className="today-main"
                headerBody={
                    <button
                        type="button"
                        className="today-place"
                        aria-haspopup="dialog"
                        aria-label={
                            start && placeName
                                ? `Plan from: ${placeName}, ${startAge(start, nowMs)}`
                                : 'Plan from: choose a place'
                        }
                        disabled={locating}
                        onClick={() => openPicker()}
                    >
                        <span aria-hidden="true">{start?.kind === 'boat' || locating ? '⛵' : '📍'}</span>
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
                                    disabled={!view}
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
                                {shortCredit(base)}
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
                                        {chip.agreement && (
                                            <svg aria-hidden="true" viewBox="0 0 24 24" className="today-glyph">
                                                <path d={AGREEMENT_GLYPH[chip.agreement]} />
                                            </svg>
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
                                const cell = partCell(part);
                                return (
                                    <li
                                        key={label}
                                        className="today-cell"
                                        data-level={part.level}
                                        aria-label={cell.ariaLabel}
                                    >
                                        <span className="today-cell-label">{cell.label}</span>
                                        <span className="today-cell-wind">
                                            <span aria-hidden="true">{cell.glyph}</span>
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
                        {view && view.top.length > 0 && view.state !== 'no-daylight' && (
                            <ul aria-label="Stops" className="today-stops">
                                {view.top.map((row) => (
                                    <li key={row.id}>
                                        <StopButton row={row} onOpen={() => setScreen({ stop: row.id })} />
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
                    polarIsOwn={!!settings.polarData}
                    leavingMarina={!!base.marina}
                    loadLanding={detailRow.candidate.reviewed?.landingTide ? loadLanding : null}
                    onPlot={(departureMs) => plot(detailRow, departureMs)}
                    onBack={() => setScreen(null)}
                />
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

function StopButton({ row, onOpen }: { row: StopRow; onOpen: () => void }) {
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
                    {row.parks && <span className="today-tag">Parks</span>}
                </span>
                <span className="today-stop-l2">{row.line2}</span>
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
    const swept = new Set(view.top.map((r) => r.id));
    // An OpenStreetMap place over a day old carries the date it was mapped.
    const mapped = (id: string) => {
        const at = base.places?.candidates.find((x) => x.id === id)?.mappedAtMs;
        return at === undefined ? null : `mapped ${dayMonth(at, base.zone)}`;
    };
    return (
        <TodayModal title={`Places near ${base.start.name}`} onClose={onClose} className="today-list-card">
            <h3 className="today-h3">Fits {day}</h3>
            {view.fits.length ? (
                <ul className="today-stops">
                    {view.fits.map((row) =>
                        swept.has(row.id) ? (
                            <li key={row.id}>
                                <StopButton row={row} onOpen={() => onOpen(row.id)} />
                            </li>
                        ) : (
                            <li key={row.id} className="today-place-line">
                                {row.name} · {row.shelter} · {lowerFirst(row.line2)}
                                {row.mapped ? ` · ${row.mapped}` : ''}
                            </li>
                        ),
                    )}
                </ul>
            ) : (
                <p className="today-place-line">Nothing fits {day}.</p>
            )}
            <h3 className="today-h3">Not {day}</h3>
            {view.notToday.length ? (
                <ul>
                    {view.notToday.map((row) => (
                        <li key={row.id} className="today-place-line">
                            {row.name} · {row.reason}
                            {mapped(row.id) ? ` · ${mapped(row.id)}` : ''}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="today-place-line">Every place in reach fits.</p>
            )}
        </TodayModal>
    );
}
